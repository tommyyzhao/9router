#!/usr/bin/env python3
"""Dependency-free gateway self-healing checks.

Default mode is offline and cannot call launchctl.  Real launchd tests require
--real-launchd plus a private temporary HOME and approved scratch ports.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/service/gateway_service.py"
RELEASE_SOURCE = ROOT / "scripts/service/gateway_release.py"
spec = importlib.util.spec_from_file_location("gateway_service", SOURCE)
service = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(service)
sys.modules["gateway_service"] = service
release_spec = importlib.util.spec_from_file_location("gateway_release", RELEASE_SOURCE)
release_tool = importlib.util.module_from_spec(release_spec)
assert release_spec.loader is not None
release_spec.loader.exec_module(release_tool)


def expect_error(fragment, function, *args, **kwargs):
    try:
        function(*args, **kwargs)
    except (service.ServiceError, release_tool.ReleaseError) as error:
        assert fragment in str(error), (fragment, str(error))
    else:
        raise AssertionError(f"Expected ServiceError containing {fragment!r}")


def make_release(base: Path, name="release") -> tuple[Path, Path, Path]:
    releases = base / "releases"
    release = releases / name
    (release / ".next").mkdir(parents=True)
    (release / "src/lib/db/migrations").mkdir(parents=True)
    (release / "server.js").write_text("server", encoding="utf-8")
    (release / "custom-server.js").write_text("custom", encoding="utf-8")
    (release / ".next/BUILD_ID").write_text(name, encoding="utf-8")
    (release / "src/lib/db/migrations/001.js").write_text("schema", encoding="utf-8")
    node = base / "node"
    if not node.exists():
        node.write_text("#!/bin/sh\n", encoding="utf-8")
        node.chmod(0o700)
    env = base / "stable.env"
    if not env.exists():
        env.write_text("SECRET=not-printed\n", encoding="utf-8")
    return release, node, env


def make_live_release(base: Path, name: str, behavior: str = "healthy") -> tuple[Path, Path, Path]:
    release, _, env = make_release(base, name)
    script = release / "custom-server.js"
    script.write_text(
        "const http=require('http');\n"
        "process.title='next-server (scratch)';\n"
        "const port=Number(process.env.PORT);\n"
        f"const behavior={json.dumps(behavior)};\n"
        "if(behavior==='prebind') process.exit(42);\n"
        "const server=http.createServer((req,res)=>{\n"
        " if(behavior==='hang') return;\n"
        " res.writeHead(200,{'content-type':'application/json'});res.end('{\\\"ok\\\":true}');\n"
        "});\n"
        "server.listen(port,'127.0.0.1',()=>{\n"
        " if(behavior==='crash') setTimeout(()=>process.exit(43),1000);\n"
        "});\n",
        encoding="utf-8",
    )
    script.chmod(0o700)
    node = Path("/opt/homebrew/Cellar/node/26.0.0/bin/node")
    assert node.is_file(), f"scratch tests require pinned Node: {node}"
    return release, node.resolve(), env


def offline_checks():
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release, node, env = make_release(base)
        schema = service.fingerprint_schema(release)
        record = service.validate_release(release, base / "releases", node, env, schema)
        assert service.validate_release(release, base / "releases", node, env, schema, record) == record
        (release / "server.js").write_text("mutated", encoding="utf-8")
        expect_error("changed", service.validate_release, release, base / "releases", node, env, schema, record)
        (release / "server.js").write_text("server", encoding="utf-8")
        outside = base / "outside"
        outside.mkdir()
        for relative in service.REQUIRED_RELEASE_FILES:
            target = outside / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("x", encoding="utf-8")
        expect_error("contained", service.validate_release, outside, base / "releases", node, env, schema)
        (release / "link").symlink_to(release / "server.js")
        expect_error("symlink", service.fingerprint_tree, release)

    with tempfile.TemporaryDirectory() as raw:
        path = Path(raw) / "state.json"
        store = service.StateStore(path)
        store.create({"phase": "idle"})
        assert path.stat().st_mode & 0o777 == 0o600
        with store.locked() as state:
            state["phase"] = "queued"
        assert store.read()["generation"] == 1
        with service.exclusive_lock(store.lock_path):
            expect_error("already held", lambda: next(_enter(service.exclusive_lock(store.lock_path, True))))
        path.write_text("not json", encoding="utf-8")
        expect_error("Unreadable", store.read)

    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release, node, env = make_release(base)
        store = service.StateStore(base / "state.json")
        release_record = service.validate_release(
            release, base / "releases", node, env, service.fingerprint_schema(release)
        )
        store.create({
            "phase": "healthy", "current": release.name, "qualified": release.name,
            "last_good": release.name,
            "releases": {release.name: release_record}, "transition": None,
            "child": {"pid": 42}, "config": {"releases_dir": str(base / "releases")},
        })
        args = argparse.Namespace(service_dir=base, release_name=release.name)
        with patch.object(service, "validate_release", return_value=release_record):
            release_tool.promote(args)
        assert store.read()["transition"]["phase"] == "queued"
        expect_error("already pending", release_tool.promote, args)
        # Schema changes are conservatively blocked before any candidate process.
        staged = dict(release_record, path=str(release))
        staged["schema_digest"] = "different"
        with store.locked() as state:
            state["transition"] = None
            state["phase"] = "healthy"
            state["releases"]["changed"] = staged
        args.release_name = "changed"
        with patch.object(release_tool.service, "validate_release", return_value=staged):
            expect_error("compatibility", release_tool.promote, args)

    # Targeted reviewer repro: rollback keeps future qualified pointer coherent.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        store = service.StateStore(base / "state.json")
        store.create({
            "current": "candidate", "qualified": "candidate", "last_good": "baseline",
            "transition": {"rollback": "baseline"}, "child": None,
            "releases": {"baseline": {"path": "baseline"}},
            "config": {"port": _free_port(), "startup_timeout": 1},
        })
        fake_record = {"pid": 42}
        with patch.object(service, "reconcile_record", return_value=None), \
             patch.object(service, "start_selected", return_value=fake_record), \
             patch.object(service, "wait_ready", return_value=True):
            service.rollback(store, store.read()["config"], "targeted repro")
        pointers = store.read()
        assert pointers["current"] == pointers["qualified"] == "baseline"

    # Targeted reviewer repro: loaded argv must be an exact ordered block.
    fake_print = subprocess.CompletedProcess([], 0,
        "arguments = {\n  /usr/bin/python-wrapper\n  --supervisor-helper\n}\n", "")
    with patch.object(service, "launchctl", return_value=fake_print):
        assert service.loaded_job_matches("gui/501/test", ["/usr/bin/python", "--supervisor"]) is False

    # Targeted reviewer repro: candidate crash budget chooses distinct last_good.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        store = service.StateStore(base / "state.json")
        now = time.time()
        store.create({
            "phase": "healthy", "current": "candidate", "qualified": "candidate",
            "last_good": "baseline", "rollback_attempted": None,
            "failures": [now - 2, now - 1], "transition": None,
            "child": {"pid": 42}, "config": {"port": _free_port(), "health_interval": 0,
                "health_failures": 1, "failure_budget": 3, "max_backoff": 0, "degraded_interval": 0},
        })
        with patch.object(service.time, "sleep"), patch.object(service, "prove_child", side_effect=service.ServiceError("dead")), \
             patch.object(service, "stop_child"), patch.object(service, "rollback", return_value=None) as rollback_call:
            service.monitor(store, store.read()["config"], {"pid": 42})
        rollback_call.assert_called_once()
        assert store.read()["rollback_attempted"] == "baseline"

    # Targeted reviewer repro: fallback health never accepts an unrelated listener.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        store = service.StateStore(base / "state.json")
        store.create({"config": {"port": _free_port()}, "guard": {"service": "gui/501/test"},
                      "child": None, "current": "x", "releases": {}})
        with patch.object(service, "listener_pids", return_value={999}), \
             patch.object(service, "loaded_job_pid", return_value=123), \
             patch.object(service, "pid_descends_from", return_value=False), \
             patch.object(service, "health", return_value=True):
            assert service.prove_install_health(store, "fallback", 1) is False

    # Queued candidate mutation is rejected before the healthy child is touched.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        healthy, node, env = make_live_release(base, "healthy")
        candidate, _, _ = make_live_release(base, "candidate")
        schema = service.fingerprint_schema(healthy)
        current = service.validate_release(healthy, base / "releases", node, env, schema)
        target = service.validate_release(candidate, base / "releases", node, env, schema)
        store = service.StateStore(base / "state.json")
        store.create({
            "phase": "transition-queued", "current": "healthy", "qualified": "healthy",
            "last_good": "healthy", "releases": {"healthy": current, "candidate": target},
            "transition": {"phase": "queued", "target": "candidate", "rollback": "healthy"},
            "child": {"sentinel": True}, "config": {"releases_dir": str(base / "releases"), "port": _free_port()},
        })
        (candidate / "server.js").write_text("changed after queue", encoding="utf-8")
        with patch.object(service, "reconcile_record", side_effect=AssertionError("old child must remain untouched")):
            expect_error("changed", service.apply_transition, store, store.read()["config"])
        assert store.read()["child"] == {"sentinel": True}

    # Install refuses existing state before writing scripts/plists.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release, node, env = make_release(base)
        service_dir = base / "service"
        service_dir.mkdir()
        (service_dir / "state.json").write_text("existing", encoding="utf-8")
        marker = base / "bin/gateway_service.py"
        install_args = argparse.Namespace(
            service_dir=service_dir, bin_dir=base / "bin", releases_dir=base / "releases",
            launch_agents=base / "LaunchAgents", log_dir=base / "logs", baseline=release,
            python=Path(sys.executable), node=node, env_file=env, schema_source=release,
            schema_digest=None, label="test.gateway", guard_label="test.gateway.guard",
            home=base, data_dir=base / "data", port=_free_port(), hostname="127.0.0.1",
            runtime_path="/usr/bin:/bin", startup_timeout=1, probation=1,
            health_interval=.1, health_failures=2, failure_budget=3, max_backoff=1,
            degraded_interval=1, guard_interval=1, bootstrap_attempts=1,
        )
        expect_error("already exists", release_tool.install, install_args)
        assert not marker.exists()

    # Use a real process whose title changes; identity never trusts argv/title.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release = base / "release"
        release.mkdir()
        script = release / "child.py"
        port = _free_port()
        script.write_text(
            "import ctypes,http.server,os\n"
            "ctypes.CDLL(None).setprogname(b'next-server (test)')\n"
            "class H(http.server.BaseHTTPRequestHandler):\n"
            " def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'{\\\"ok\\\":true}')\n"
            " def log_message(self,*a): pass\n"
            f"http.server.HTTPServer(('127.0.0.1',{port}),H).serve_forever()\n",
            encoding="utf-8",
        )
        child = subprocess.Popen([sys.executable, script], cwd=release, start_new_session=True,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not service.health(port, .2):
                time.sleep(.05)
            assert service.health(port, .2)
            snapshot = service.process_snapshot(child.pid)
            # Python's launcher path differs from its mapped Mach-O executable. The
            # service requires the mapped executable identity, as it does for Node.
            fake_release = {"node": snapshot["texts"][0], "path": str(release.resolve()), "digest": "test"}
            identity = service.capture_child_identity(child.pid, fake_release, port)
            assert child.pid in service.prove_child(identity)
            stale = dict(identity, start="Thu Jan  1 00:00:00 1970")
            expect_error("start", service.prove_child, stale)
            wrong_group = dict(identity, pgid=identity["pgid"] + 999999)
            expect_error("pgid", service.prove_child, wrong_group)
            occupied = _free_port()
            stranger = subprocess.Popen([sys.executable, "-m", "http.server", str(occupied), "--bind", "127.0.0.1"],
                                         start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not service.listener_pids(occupied):
                    time.sleep(.05)
                unknown = dict(identity, port=occupied)
                expect_error("unknown process", service.prove_child, unknown)
            finally:
                stranger.terminate()
                stranger.wait(timeout=3)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, 15)
                child.wait(timeout=3)


def _enter(manager):
    with manager as value:
        yield value


def _free_port():
    import socket
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    assert port not in {20128, 20129, 20130, 8787}
    return port


def _wait(predicate, timeout=15, interval=.1, message="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"Timed out waiting for {message}")


def _run(*args, timeout=20, check=True):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError(f"command failed {args}: {result.returncode}: {result.stderr}")
    return result


def _bootout(service_name):
    _run("/bin/launchctl", "bootout", service_name, check=False)
    _wait(lambda: _run("/bin/launchctl", "print", service_name, check=False).returncode != 0,
          timeout=10, message=f"bootout {service_name}")


def installer_sigkill_checks(python: Path, node: Path, runtime_path: str):
    """Kill prepare/arm subprocesses at deterministic disk/state boundaries."""
    with tempfile.TemporaryDirectory(prefix="9router-installer-kill-") as raw:
        base = Path(raw).resolve()
        home = base / "home"
        service_dir = home / ".9router/service"
        bin_dir = home / ".9router/bin"
        releases_dir = home / ".9router/releases"
        launch_agents = home / "Library/LaunchAgents"
        logs = home / ".9router/logs"
        data = home / ".9router/data"
        for directory in (home, data):
            directory.mkdir(parents=True, mode=0o700)
        baseline, _, env = make_live_release(home / ".9router", "baseline")
        env.write_text("SCRATCH_ONLY=1\n", encoding="utf-8")
        label = f"io.9router.selftest.prepare.{os.getpid()}.{int(time.time())}"
        guard_label = f"{label}.guard"
        port = _free_port()
        install_argv = [
            "install", "--baseline", str(baseline), "--python", str(python), "--node", str(node),
            "--env-file", str(env), "--schema-source", str(baseline), "--service-dir", str(service_dir),
            "--bin-dir", str(bin_dir), "--releases-dir", str(releases_dir),
            "--launch-agents", str(launch_agents), "--log-dir", str(logs), "--home", str(home),
            "--data-dir", str(data), "--label", label, "--guard-label", guard_label,
            "--port", str(port), "--hostname", "127.0.0.1", "--runtime-path", runtime_path,
        ]
        install_checkpoint = base / "install.checkpoint"
        install_wrapper = base / "kill-install.py"
        install_wrapper.write_text(
            "import importlib.util,sys,time\nfrom pathlib import Path\n"
            f"source=Path({str(RELEASE_SOURCE)!r}); checkpoint=Path({str(install_checkpoint)!r})\n"
            "spec=importlib.util.spec_from_file_location('gateway_release_kill',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            "original=m.service.StateStore.create\n"
            "def stop(self,state): checkpoint.write_text(str(self.path)); time.sleep(60)\n"
            "m.service.StateStore.create=stop\nsys.argv=[str(source)]+sys.argv[1:]\nm.main()\n",
            encoding="utf-8",
        )
        process = subprocess.Popen([str(python), str(install_wrapper), *install_argv], start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        _wait(install_checkpoint.exists, timeout=15, message="installer pre-state checkpoint")
        assert (bin_dir / "gateway_service.py").is_file()
        assert (service_dir / f"{label}.supervisor.plist").is_file()
        assert not (service_dir / "state.json").exists()
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
        _run(str(python), str(RELEASE_SOURCE), *install_argv)
        store = service.StateStore(service_dir / "state.json")
        assert store.read()["phase"] == "installed-unarmed"

        original = base / "original.plist"
        original_payload = {
            "Label": label,
            "ProgramArguments": [str(node), f"--env-file={env}", str(baseline / "custom-server.js")],
            "WorkingDirectory": str(baseline), "RunAtLoad": True, "KeepAlive": True,
            "EnvironmentVariables": {"PORT": str(port), "HOSTNAME": "127.0.0.1",
                                     "HOME": str(home), "DATA_DIR": str(data), "PATH": runtime_path},
        }
        original.write_bytes(plistlib.dumps(original_payload))
        arm_checkpoint = base / "arm.checkpoint"
        arm_wrapper = base / "kill-arm.py"
        arm_wrapper.write_text(
            "import importlib.util,sys,time\nfrom pathlib import Path\n"
            f"source=Path({str(RELEASE_SOURCE)!r}); checkpoint=Path({str(arm_checkpoint)!r})\n"
            "spec=importlib.util.spec_from_file_location('gateway_release_arm_kill',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            "original=m._copy_atomic\n"
            "def stop(source_path,destination,mode):\n original(source_path,destination,mode)\n"
            " if destination.name=='original-gateway.plist': checkpoint.write_text(str(destination)); time.sleep(60)\n"
            "m._copy_atomic=stop\nsys.argv=[str(source)]+sys.argv[1:]\nm.main()\n",
            encoding="utf-8",
        )
        arm_argv = ["arm-install", "--service-dir", str(service_dir), "--original-plist", str(original)]
        process = subprocess.Popen([str(python), str(arm_wrapper), *arm_argv], start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        _wait(arm_checkpoint.exists, timeout=10, message="arm backup-before-intent checkpoint")
        assert (service_dir / "original-gateway.plist").read_bytes() == original.read_bytes()
        assert store.read()["install_transaction"] is None
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
        _run(str(python), str(RELEASE_SOURCE), *arm_argv)
        transaction = store.read()["install_transaction"]
        assert transaction["phase"] == "armed"
        assert transaction["original_digest"] == hashlib.sha256(original.read_bytes()).hexdigest()


def real_launchd_checks():
    assert sys.platform == "darwin", "real launchd tests require macOS"
    assert os.environ.get("GATEWAY_SELFTEST_REAL") == "1", "set GATEWAY_SELFTEST_REAL=1"
    pinned_python = Path(sys.executable).resolve()
    pinned_node = Path("/opt/homebrew/Cellar/node/26.0.0/bin/node").resolve()
    runtime_path = os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    installer_started = time.monotonic()
    installer_sigkill_checks(pinned_python, pinned_node, runtime_path)
    installer_duration = time.monotonic() - installer_started
    uid = os.getuid()
    suffix = f"{uid}.{os.getpid()}.{int(time.time())}"
    label = f"io.9router.selftest.gateway.{suffix}"
    guard_label = f"{label}.guard"
    domain = f"gui/{uid}"
    gateway_service = f"{domain}/{label}"
    guard_service = f"{domain}/{guard_label}"
    port = _free_port()
    timings = {}
    with tempfile.TemporaryDirectory(prefix="9router-launchd-selftest-") as raw:
        base = Path(raw).resolve()
        home = base / "home"
        service_dir = home / ".9router/service"
        bin_dir = home / ".9router/bin"
        releases_dir = home / ".9router/releases"
        launch_agents = home / "Library/LaunchAgents"
        logs = home / ".9router/logs"
        data = home / ".9router/data"
        for directory in (home, data):
            directory.mkdir(parents=True, mode=0o700)
        healthy, node, env = make_live_release(home / ".9router", "healthy")
        env.write_text("SCRATCH_ONLY=1\n", encoding="utf-8")
        schema_source = healthy
        python = Path(sys.executable).resolve()
        install_args = [
            str(RELEASE_SOURCE), "install", "--baseline", str(healthy), "--python", str(python),
            "--node", str(node), "--env-file", str(env), "--schema-source", str(schema_source),
            "--service-dir", str(service_dir), "--bin-dir", str(bin_dir),
            "--releases-dir", str(releases_dir), "--launch-agents", str(launch_agents),
            "--log-dir", str(logs), "--home", str(home), "--data-dir", str(data),
            "--label", label, "--guard-label", guard_label, "--port", str(port),
            "--runtime-path", os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
            "--hostname", "127.0.0.1", "--startup-timeout", "8", "--probation", "2",
            "--health-interval", ".25", "--health-failures", "2", "--failure-budget", "3",
            "--max-backoff", "1", "--degraded-interval", "2", "--guard-interval", ".5",
            "--bootstrap-attempts", "2",
        ]
        _run(str(python), *install_args)
        store = service.StateStore(service_dir / "state.json")
        gateway_plist = service_dir / f"{label}.supervisor.plist"
        final_gateway_plist = launch_agents / f"{label}.plist"
        guard_plist = launch_agents / f"{guard_label}.plist"
        # Test-only guard wrapper pauses exactly after stable bootstrap and before
        # the loaded phase write; launchd restarts it after SIGKILL.
        guard_checkpoint = base / "guard-after-bootstrap.checkpoint"
        guard_wrapper = base / "guard-kill-wrapper.py"
        guard_wrapper.write_text(
            "import importlib.util,time\nfrom pathlib import Path\n"
            f"source=Path({str(bin_dir / 'gateway_service.py')!r}); checkpoint=Path({str(guard_checkpoint)!r}); service_dir=Path({str(service_dir)!r})\n"
            "spec=importlib.util.spec_from_file_location('gateway_service_guard_kill',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            "original=m.bootstrap_with_fallback\n"
            "def stop(*args,**kwargs):\n result=original(*args,**kwargs)\n"
            " if not checkpoint.exists(): checkpoint.write_text(result); time.sleep(60)\n"
            " return result\n"
            "m.bootstrap_with_fallback=stop\nm.guard(service_dir)\n",
            encoding="utf-8",
        )
        guard_payload = plistlib.loads(guard_plist.read_bytes())
        guard_payload["ProgramArguments"] = [str(python), str(guard_wrapper)]
        guard_plist.write_bytes(plistlib.dumps(guard_payload))

        fallback = base / "fallback.plist"
        fallback_payload = {
            "Label": label,
            "ProgramArguments": [str(node), f"--env-file={env}", str(healthy / "custom-server.js")],
            "WorkingDirectory": str(healthy),
            "EnvironmentVariables": {"HOSTNAME": "127.0.0.1", "PORT": str(port),
                                     "HOME": str(home), "DATA_DIR": str(data),
                                     "PATH": os.environ.get("PATH", "")},
            "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 1,
            "StandardOutPath": str(logs / "original.log"),
            "StandardErrorPath": str(logs / "original.err"),
        }
        fallback.write_bytes(plistlib.dumps(fallback_payload))
        _run(str(python), str(RELEASE_SOURCE), "arm-install", "--service-dir", str(service_dir),
             "--original-plist", str(fallback))
        jobs = [guard_service, gateway_service]
        try:
            # Real old direct job exists before the independent guard migrates it.
            _run("/bin/launchctl", "bootstrap", domain, str(fallback))
            _wait(lambda: service.health(port, .2), timeout=8, message="old direct job")
            old_direct_pid = service.loaded_job_pid(gateway_service)
            assert old_direct_pid in service.listener_pids(port)
            start = time.monotonic()
            _run("/bin/launchctl", "bootstrap", domain, str(guard_plist))
            _wait(guard_checkpoint.exists, timeout=15, message="guard post-bootstrap checkpoint")
            _wait(lambda: service.loaded_job_pid(gateway_service) is not None and service.health(port, .2),
                  timeout=12, message="stable supervisor healthy before guard kill")
            stable_pid_before_guard_kill = service.loaded_job_pid(gateway_service)
            assert store.read()["install_transaction"]["phase"] == "bootstrapping-stable"
            killed = _run("/bin/launchctl", "kill", "SIGKILL", guard_service, check=False)
            assert killed.returncode == 0, killed.stderr
            _wait(lambda: store.read().get("install_transaction", {}).get("phase") == "committed" and service.health(port, .2),
                  timeout=20, message="guard-kill adoption migration")
            assert service.loaded_job_pid(gateway_service) == stable_pid_before_guard_kill
            timings["initial_migration"] = time.monotonic() - start
            state = store.read()
            assert state["install_transaction"]["phase"] == "committed", state
            assert state["install_transaction"]["loaded"] == "stable", state
            assert final_gateway_plist.read_bytes() == gateway_plist.read_bytes()
            assert service.loaded_job_pid(gateway_service) != old_direct_pid
            assert _run("/bin/launchctl", "print", gateway_service, check=False).returncode == 0

            # Missing-job recovery is autonomous; no command starts gateway after bootout.
            start = time.monotonic()
            _bootout(gateway_service)
            _wait(lambda: _run("/bin/launchctl", "print", gateway_service, check=False).returncode == 0 and service.health(port, .2),
                  timeout=15, message="missing-job recovery")
            timings["missing_job"] = time.monotonic() - start

            # Supervisor SIGKILL: launchd restarts supervisor; recorded owned child
            # is reconciled without a second listener or orphan.
            state = store.read()
            old_child = state["child"]["pid"]
            supervisor_pid = int(_run("/bin/launchctl", "print", gateway_service).stdout.split("pid = ", 1)[1].splitlines()[0])
            before_generation = state["generation"]
            killed = _run("/bin/launchctl", "kill", "SIGKILL", gateway_service, check=False)
            if killed.returncode:
                raise AssertionError(f"scratch supervisor kill blocked: {killed.stderr}")
            start = time.monotonic()
            def relaunched_supervisor():
                result = _run("/bin/launchctl", "print", gateway_service, check=False)
                if result.returncode or "pid = " not in result.stdout:
                    return False
                new_pid = int(result.stdout.split("pid = ", 1)[1].splitlines()[0])
                return new_pid != supervisor_pid and store.read()["generation"] > before_generation and service.health(port, .2)
            _wait(relaunched_supervisor, timeout=15, message="new supervisor relaunch and state activity")
            timings["supervisor_kill"] = time.monotonic() - start
            state = store.read()
            assert state["child"]["pid"] == old_child
            assert service.listener_pids(port) == {old_child}

            # A hung local health handler triggers bounded restart recovery.
            hung, _, _ = make_live_release(home / ".9router", "hang", "hang")
            schema = state["releases"][state["qualified"]]["schema_digest"]
            hung_record = service.validate_release(hung, releases_dir, node, env, schema)
            with store.locked() as locked:
                locked["releases"]["hang"] = hung_record
                locked["transition"] = {"id": "hang", "phase": "queued", "target": "hang",
                                        "rollback": locked["qualified"], "queued_at": time.time()}
                locked["phase"] = "transition-queued"
            start = time.monotonic()
            _wait(lambda: store.read().get("transition") is None and store.read().get("current") == "healthy",
                  timeout=35, message="hung-health rollback")
            timings["hung_health_rollback"] = time.monotonic() - start
            assert service.health(port, .2)

            # Candidate prebind failure rolls back to the qualified release.
            broken, _, _ = make_live_release(home / ".9router", "prebind", "prebind")
            schema = store.read()["releases"][store.read()["qualified"]]["schema_digest"]
            broken_record = service.validate_release(broken, releases_dir, node, env, schema)
            with store.locked() as locked:
                locked["releases"]["prebind"] = broken_record
                locked["transition"] = {"id": "prebind", "phase": "queued", "target": "prebind",
                                        "rollback": locked["qualified"], "queued_at": time.time()}
                locked["phase"] = "transition-queued"
            start = time.monotonic()
            _wait(lambda: store.read().get("transition") is None and store.read().get("phase") == "healthy",
                  timeout=20, message="prebind rollback")
            timings["prebind_rollback"] = time.monotonic() - start
            assert store.read()["current"] == "healthy"
            assert service.health(port, .2)

            # Measure the exact identity/readiness cost used by the supervisor.
            # Scratch initially uses an 8s fault-injection deadline; healthy
            # promotions below use the production 45s startup deadline.
            readiness_record = store.read()["child"]
            probe_samples = []
            for _ in range(3):
                probe_start = time.monotonic()
                service.prove_child(readiness_record, require_listener=True)
                probe_samples.append(time.monotonic() - probe_start)
            readiness_start = time.monotonic()
            assert service.wait_ready(readiness_record, 45)
            readiness_elapsed = time.monotonic() - readiness_start
            timings["identity_probe_max"] = max(probe_samples)
            timings["wait_ready_probe"] = readiness_elapsed
            startup_timeout = 45.0
            with store.locked() as locked:
                locked["config"]["startup_timeout"] = startup_timeout

            # A deployer may die immediately after atomically queuing intent;
            # the launchd-owned supervisor still completes the transition.
            promoted, _, _ = make_live_release(home / ".9router", "promoted", "healthy")
            promoted_record = service.validate_release(promoted, releases_dir, node, env, schema)
            with store.locked() as locked:
                locked["releases"]["promoted"] = promoted_record
            deployer = subprocess.Popen([
                str(python), "-c",
                "import fcntl,json,os,time;from pathlib import Path;p=Path(os.environ['STATE']);"
                "f=open(str(p)+'.lock','r+');fcntl.flock(f,fcntl.LOCK_EX);s=json.loads(p.read_text());"
                "s['generation']+=1;s['transition']={'id':'deployer','phase':'queued','target':'promoted','rollback':s['qualified'],'queued_at':time.time()};"
                "t=p.with_name('.deployer.tmp');t.write_text(json.dumps(s));os.replace(t,p);fcntl.flock(f,fcntl.LOCK_UN);f.close();time.sleep(30)",
            ], env={**os.environ, "STATE": str(store.path)}, start_new_session=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _wait(lambda: (store.read().get("transition") or {}).get("id") == "deployer" or store.read().get("current") == "promoted",
                  timeout=5, message="deployer intent")
            os.killpg(deployer.pid, signal.SIGKILL)
            deployer.wait(timeout=3)
            start = time.monotonic()
            _wait(lambda: ((store.read().get("child") or {}).get("release") == str(promoted)
                           or store.read().get("current") == "promoted"),
                  timeout=startup_timeout, message="promoted child identity persistence")
            timings["deployer_child_recorded"] = time.monotonic() - start
            promoted_child = store.read().get("child")
            assert promoted_child and promoted_child["release"] == str(promoted)
            _wait(lambda: service.listener_pids(port) == {promoted_child["pid"]},
                  timeout=startup_timeout, message="promoted listener ownership")
            probe_start = time.monotonic()
            service.prove_child(promoted_child, require_listener=True)
            timings["deployer_identity_probe"] = time.monotonic() - probe_start
            transition_deadline = (startup_timeout + float(store.read()["config"]["probation"])
                                   + 2 * timings["deployer_identity_probe"] + 5)
            _wait(lambda: store.read().get("transition") is None and store.read().get("current") == "promoted",
                  timeout=transition_deadline, message="killed deployer promotion")
            timings["deployer_kill"] = time.monotonic() - start
            assert service.health(port, .2)
            # Promote old healthy back so it remains the intended rollback baseline.
            with store.locked() as locked:
                locked["transition"] = {"id": "baseline", "phase": "queued", "target": "healthy",
                                        "rollback": locked["qualified"], "queued_at": time.time()}
                locked["phase"] = "transition-queued"
            _wait(lambda: store.read().get("transition") is None and store.read().get("current") == "healthy",
                  timeout=transition_deadline, message="restore baseline after deployer test")

            # Post-ready crash fails probation and rolls back.
            crash, _, _ = make_live_release(home / ".9router", "crash", "crash")
            crash_record = service.validate_release(crash, releases_dir, node, env, schema)
            with store.locked() as locked:
                locked["releases"]["crash"] = crash_record
                locked["transition"] = {"id": "crash", "phase": "queued", "target": "crash",
                                        "rollback": locked["qualified"], "queued_at": time.time()}
                locked["phase"] = "transition-queued"
            start = time.monotonic()
            _wait(lambda: store.read().get("transition") is None and store.read().get("current") == "healthy",
                  timeout=transition_deadline, message="post-ready crash rollback")
            timings["crash_rollback"] = time.monotonic() - start
            assert service.health(port, .2)

            # A candidate first passes readiness and probation. Repeated real child
            # exits then exhaust the durable monitor budget and select last_good.
            crashloop, _, _ = make_live_release(home / ".9router", "crashloop", "healthy")
            crashloop_record = service.validate_release(crashloop, releases_dir, node, env, schema)
            with store.locked() as locked:
                locked["releases"]["crashloop"] = crashloop_record
                locked["transition"] = {"id": "crashloop", "phase": "queued", "target": "crashloop",
                                        "rollback": locked["qualified"], "queued_at": time.time()}
                locked["phase"] = "transition-queued"
            start = time.monotonic()
            _wait(lambda: store.read().get("transition") is None
                  and store.read().get("current") == "crashloop"
                  and store.read().get("phase") == "healthy",
                  timeout=transition_deadline, message="post-probation crashloop qualification")
            qualified_at = time.monotonic()
            assert store.read()["last_good"] == "healthy"
            failure_budget = int(store.read()["config"]["failure_budget"])
            for attempt in range(failure_budget):
                failed_record = store.read()["child"]
                assert failed_record["release"] == str(crashloop)
                service.signal_child(failed_record, signal.SIGKILL, require_listener=True)
                if attempt + 1 < failure_budget:
                    _wait(lambda old_pid=failed_record["pid"]: store.read().get("current") == "crashloop"
                          and store.read().get("phase") == "healthy"
                          and (store.read().get("child") or {}).get("pid") != old_pid,
                          timeout=transition_deadline, message=f"crashloop restart {attempt + 1}")
                else:
                    _wait(lambda: store.read().get("transition") is None
                          and store.read().get("current") == "healthy"
                          and store.read().get("phase") == "healthy",
                          timeout=transition_deadline, message="crash-budget rollback")
            timings["post_probation_crash_rollback"] = time.monotonic() - qualified_at
            assert store.read()["rollback_attempted"] == "healthy"
            assert service.health(port, .2)

            # The fallback then fails while the budget remains exhausted. It must
            # enter degraded state, leave no child, wait, then retry slowly.
            baseline_record = store.read()["child"]
            degraded_interval = float(store.read()["config"]["degraded_interval"])
            service.signal_child(baseline_record, signal.SIGKILL, require_listener=True)
            _wait(lambda: store.read().get("phase") == "degraded" and store.read().get("child") is None,
                  timeout=10, interval=.02, message="failing baseline degraded state")
            degraded_at = float(store.read()["diagnostic_at"])
            _wait(lambda: (store.read().get("child") or {}).get("pid") not in (None, baseline_record["pid"]),
                  timeout=degraded_interval + startup_timeout, interval=.02,
                  message="slow degraded baseline retry")
            retry_recorded_at = time.time()
            timings["failing_baseline_slow_retry"] = retry_recorded_at - degraded_at
            assert timings["failing_baseline_slow_retry"] >= degraded_interval - .25
            _wait(lambda: store.read().get("phase") == "healthy" and service.health(port, .2),
                  timeout=startup_timeout, message="baseline healthy after slow retry")

            # Loaded-but-unhealthy stable job is explicitly booted out before the
            # original fallback is loaded; future recovery persists that fallback.
            _bootout(guard_service)
            _bootout(gateway_service)
            stale_record = store.read().get("child")
            if stale_record:
                with contextlib.suppress(service.ServiceError):
                    service.stop_child(stale_record, graceful=1)
                with store.locked() as locked:
                    if locked.get("child") == stale_record:
                        locked["child"] = None
            _wait(lambda: not service.listener_pids(port), timeout=5,
                  message="pre-unhealthy listener cleanup")
            unhealthy_plist = service_dir / "unhealthy-stable.plist"
            unhealthy_config = plistlib.loads(gateway_plist.read_bytes())
            unhealthy_config["ProgramArguments"] = [str(node), "-e", "setInterval(()=>{},1000)"]
            unhealthy_plist.write_bytes(plistlib.dumps(unhealthy_config))
            with store.locked() as locked:
                locked["install_transaction"] = {
                    "phase": "bootstrapping-stable", "stable_plist": str(unhealthy_plist),
                    "fallback_plist": str(fallback), "fallback_arguments": fallback_payload["ProgramArguments"],
                    "original_digest": hashlib.sha256(fallback.read_bytes()).hexdigest(),
                    "final_plist": str(final_gateway_plist), "armed_at": time.time(),
                }
                locked["guard"]["install_health_timeout"] = 2
                locked["phase"] = "installing"
            start = time.monotonic()
            _run("/bin/launchctl", "bootstrap", domain, str(guard_plist))
            _wait(lambda: store.read().get("install_transaction", {}).get("phase") == "committed"
                  and service.health(port, .2),
                  timeout=18, message="loaded unhealthy stable fallback")
            state = store.read()
            timings["loaded_unhealthy_fallback"] = time.monotonic() - start
            assert state["install_transaction"]["loaded"] == "fallback", state
            assert state["guard"]["stable_plist"] == str(final_gateway_plist)
            assert final_gateway_plist.read_bytes() == fallback.read_bytes()
            _bootout(gateway_service)
            _wait(lambda: _run("/bin/launchctl", "print", gateway_service, check=False).returncode == 0
                  and service.health(port, .2),
                  timeout=10, message="persisted fallback missing-job recovery")

            # Reproduce the rejected-bootstrap incident shape. The invalid stable
            # plist is rejected before launch; guard persists fallback, then only
            # the exact digest-bound original is loaded and committed.
            bad_stable = service_dir / "bad-stable.plist"
            bad_stable.write_text("not a plist", encoding="utf-8")
            _bootout(gateway_service)
            with store.locked() as locked:
                locked["guard"]["stable_plist"] = str(bad_stable)
                locked["install_transaction"] = {
                    "phase": "bootstrapping-stable", "stable_plist": str(bad_stable),
                    "fallback_plist": str(fallback), "fallback_arguments": fallback_payload["ProgramArguments"],
                    "original_digest": hashlib.sha256(fallback.read_bytes()).hexdigest(),
                    "final_plist": str(final_gateway_plist), "armed_at": time.time(),
                }
                locked["phase"] = "installing"
            start = time.monotonic()
            _wait(lambda: store.read().get("install_transaction", {}).get("phase") == "fallback",
                  timeout=5, interval=.02, message="bootstrap rejection persisted fallback")
            assert not service._loaded(gateway_service)
            _wait(lambda: store.read().get("install_transaction", {}).get("phase") == "committed"
                  and service.health(port, .2),
                  timeout=20, message="bootstrap rejection fallback")
            state = store.read()
            timings["bootstrap_rejection_fallback"] = time.monotonic() - start
            assert state["install_transaction"]["phase"] == "committed", state
            assert state["install_transaction"]["loaded"] == "fallback", state
            assert final_gateway_plist.read_bytes() == fallback.read_bytes()

        except BaseException:
            print("SCRATCH DEBUG", base, "port", port, file=sys.stderr)
            with contextlib.suppress(Exception):
                print("STATE", json.dumps(store.read(), indent=2), file=sys.stderr)
            for diagnostic in (logs / "guard.err", logs / "guard.log", logs / "supervisor.err", logs / "supervisor.log", logs / "gateway-child.log"):
                if diagnostic.exists():
                    print(diagnostic.name, diagnostic.read_text(errors="replace")[-4000:], file=sys.stderr)
            raise
        finally:
            for job in jobs:
                _bootout(job)
            with contextlib.suppress(Exception):
                record = store.read().get("child")
                if record:
                    service.stop_child(record, graceful=1)
            _wait(lambda: not service.listener_pids(port), timeout=5, message="scratch listener cleanup")
            listeners = service.listener_pids(port)
            assert not listeners, f"scratch listener leaked: {listeners}"
            assert _run("/bin/launchctl", "print", gateway_service, check=False).returncode != 0
            assert _run("/bin/launchctl", "print", guard_service, check=False).returncode != 0
    timings["installer_and_arm_sigkill"] = installer_duration
    print("PASS real launchd:", json.dumps({name: round(value, 3) for name, value in timings.items()}, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real-launchd", action="store_true")
    args = parser.parse_args()
    offline_checks()
    print("PASS offline: atomic state/locks, release/schema/env binding, symlink rejection, identity/title/PID/group/listener checks")
    if args.real_launchd:
        real_launchd_checks()


if __name__ == "__main__":
    main()
