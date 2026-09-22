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
import threading
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
    # Probe failure never proves death; ownership remains retained.
    with patch.object(service, "_pid_absent", return_value=False), \
         patch.object(service, "process_snapshot", side_effect=service.ServiceError("probe denied")):
        assert service.wait_gone({"pid": 42, "start": "start"}, .01) is False

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

    # Liveness probes fail closed; only a confirmed absent PID clears ownership.
    with patch.object(service, "process_snapshot", side_effect=service.ServiceError("probe denied")), \
         patch.object(service, "_pid_absent", return_value=False):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            store = service.StateStore(base / "state.json")
            port = _free_port()
            record = {"pid": 42, "start": "start", "pgid": 42, "port": port}
            store.create({"child": record, "config": {"port": port}})
            with patch.object(service, "listener_pids", return_value=set()), \
                 patch.object(service, "process_group", return_value={}):
                expect_error("Ambiguous live", service.reconcile_record, store, port)
            assert store.read()["child"] == record
    with patch.object(service, "process_snapshot", side_effect=service.ServiceError("probe denied")), \
         patch.object(service, "_pid_absent", return_value=True):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            store = service.StateStore(base / "state.json")
            port = _free_port()
            record = {"pid": 42, "start": "start", "pgid": 42, "port": port}
            store.create({"child": record, "config": {"port": port}})
            with patch.object(service, "listener_pids", return_value=set()), \
                 patch.object(service, "process_group", return_value={}):
                assert service.reconcile_record(store, port) is None
            assert store.read()["child"] is None
    with patch.object(service, "_pid_absent", return_value=False), \
         patch.object(service, "process_snapshot", side_effect=service.ServiceError("probe denied")):
        assert service.wait_gone({"pid": 42, "start": "start", "pgid": 42, "port": 1}, .01) is False
    with patch.object(service.os, "waitpid", side_effect=AssertionError("invalid PID reached waitpid")):
        expect_error("Invalid child PID", service._pid_absent, 1)
        expect_error("Invalid child PID", service._pid_absent, True)

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

    # A dead leader with a surviving private-group descendant cannot clear ownership.
    survivor_record = {"pid": 42, "start": "start", "pgid": 42, "port": 8080}
    with patch.object(service, "_pid_absent", return_value=True), \
         patch.object(service, "process_group", return_value={99: (1, 42, 42)}), \
         patch.object(service, "listener_pids", return_value={99}):
        assert service._confirmed_record_gone(survivor_record) is False

    # Successful stop clears only after proven absence.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release = base / "release"
        release.mkdir()
        script = release / "child.py"
        script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
        child = subprocess.Popen([sys.executable, str(script)], cwd=release, start_new_session=True)
        try:
            snapshot = service.process_snapshot(child.pid)
            record = {"pid": child.pid, "start": snapshot["start"], "pgid": snapshot["pgid"],
                      "session": snapshot["session"], "node": snapshot["texts"][0],
                      "cwd": snapshot["cwd"], "release": str(release), "release_digest": "test", "port": _free_port()}
            def direct_signal(_record, sig, **_kwargs):
                os.kill(_record["pid"], sig)
            with patch.object(service, "prove_child"), patch.object(service, "signal_child", side_effect=direct_signal):
                service.stop_child(record, graceful=.1)
            assert child.poll() is not None
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)

    # Targeted reviewer repro: loaded argv must be an exact ordered block.
    fake_print = subprocess.CompletedProcess([], 0,
        "arguments = {\n  /usr/bin/python-wrapper\n  --supervisor-helper\n}\n", "")
    with patch.object(service, "launchctl", return_value=fake_print):
        assert service.loaded_job_matches("gui/501/test", ["/usr/bin/python", "--supervisor"]) is False

    # Rollback readiness-stop failure preserves the underlying stop cause.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release, node, env = make_release(base, "baseline")
        record = {"pid": 42, "start": "start"}
        release_record = service.validate_release(release, base / "releases", node, env,
                                                  service.fingerprint_schema(release))
        store = service.StateStore(base / "state.json")
        store.create({"phase": "rollback-starting", "current": "candidate", "qualified": "candidate",
                      "last_good": "baseline", "transition": {"rollback": "baseline"}, "child": record,
                      "releases": {"baseline": release_record}, "config": {"port": _free_port(),
                      "startup_timeout": 1, "releases_dir": str(base / "releases"), "hostname": "127.0.0.1",
                      "data_dir": str(base), "home": str(base), "child_log": str(base / "child.log")}})
        with patch.object(service, "reconcile_record", return_value=None), \
             patch.object(service, "start_selected", return_value=record), \
             patch.object(service, "wait_ready", return_value=False), \
             patch.object(service, "stop_child", side_effect=service.ServiceError("stop denied")):
            service.rollback(store, store.read()["config"], "rollback test")
        assert "stop denied" in store.read()["diagnostic"]
        assert store.read()["child"] == record and store.read()["phase"] == "degraded"

    # True supervisor startup readiness-stop failure retains persisted child.
    class StopSupervise(BaseException):
        pass
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release, node, env = make_release(base, "healthy")
        release_record = service.validate_release(release, base / "releases", node, env,
                                                  service.fingerprint_schema(release))
        store = service.StateStore(base / "state.json")
        record = {"pid": 42, "start": "start", "release": release_record["path"],
                  "release_digest": release_record["digest"]}
        config = {"port": _free_port(), "current": "healthy", "releases_dir": str(base / "releases"),
                  "startup_timeout": 1, "failure_budget": 3, "max_backoff": 0,
                  "degraded_interval": 0, "health_interval": 0}
        store.create({"phase": "healthy", "current": "healthy", "qualified": "healthy",
                      "last_good": "healthy", "transition": None, "child": None,
                      "releases": {"healthy": release_record}, "config": config})
        def persist_start(start_store, *_args):
            with start_store.locked() as state:
                state["child"] = record
                state["phase"] = "starting"
            return record
        with patch.object(service, "recover_interrupted"), \
             patch.object(service, "apply_transition", return_value=None), \
             patch.object(service, "start_selected", side_effect=persist_start), \
             patch.object(service, "wait_ready", return_value=False), \
             patch.object(service, "stop_child", side_effect=service.ServiceError("startup stop denied")), \
             patch.object(service.time, "sleep", side_effect=StopSupervise):
            try:
                service.supervise(base)
            except StopSupervise:
                pass
            else:
                raise AssertionError("supervise test did not stop at bounded retry")
        state = store.read()
        assert state["child"] == record
        assert state["phase"] == "degraded"
        assert "startup stop denied" in state["diagnostic"]

    # Retained-child recovery refuses a concurrent phase/transition change.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release, node, env = make_release(base, "healthy")
        release_record = service.validate_release(release, base / "releases", node, env,
                                                  service.fingerprint_schema(release))
        store = service.StateStore(base / "state.json")
        record = {"pid": 42, "release": release_record["path"], "release_digest": release_record["digest"]}
        config = {"startup_timeout": 1}
        store.create({"phase": "degraded", "current": "healthy", "transition": None,
                      "child": record, "releases": {"healthy": release_record}, "config": config})
        def mutate_during_ready(_record, _timeout):
            with store.locked() as locked:
                locked["phase"] = "restarting"
            return True
        with patch.object(service, "wait_ready", side_effect=mutate_during_ready):
            expect_error("changed during recovery", service.recover_retained_child, store, config, record)
        assert store.read()["phase"] == "restarting"

    # A transient retained-readiness miss must return through monitor, then retry
    # full recovery without replacing the unchanged healthy child.
    class RetainedSupervise(BaseException):
        pass
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        release, node, env = make_release(base, "healthy")
        release_record = service.validate_release(release, base / "releases", node, env,
                                                  service.fingerprint_schema(release))
        store = service.StateStore(base / "state.json")
        record = {"pid": 42, "release": release_record["path"],
                  "release_digest": release_record["digest"]}
        config = {"port": _free_port(), "startup_timeout": 1, "health_interval": 0,
                  "health_failures": 1, "failure_budget": 3, "degraded_interval": 0,
                  "max_backoff": 0}
        store.create({"phase": "degraded", "current": "healthy", "transition": None,
                      "child": record, "releases": {"healthy": release_record}, "config": config})
        readiness = iter((False, True))
        sleeps = 0
        def stop_after_recovery(_seconds):
            nonlocal sleeps
            sleeps += 1
            if sleeps == 2:
                raise RetainedSupervise()
        with patch.object(service, "recover_interrupted"), \
             patch.object(service, "apply_transition", return_value=record), \
             patch.object(service, "wait_ready", side_effect=lambda *_: next(readiness)), \
             patch.object(service, "prove_child"), \
             patch.object(service, "health", return_value=True), \
             patch.object(service.time, "sleep", side_effect=stop_after_recovery):
            try:
                service.supervise(base)
            except RetainedSupervise:
                pass
            else:
                raise AssertionError("supervise did not reach post-recovery monitor")
        assert store.read()["phase"] == "healthy"
        assert store.read()["child"] == record
        assert sleeps == 2

    # Stop failure retains durable child ownership in restart and budget paths.
    stop_failure = service.ServiceError("stop denied")
    for exhausted in (False, True):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            store = service.StateStore(base / "state.json")
            record = {"pid": 42, "start": "start"}
            now = time.time()
            store.create({
                "phase": "healthy", "current": "candidate", "qualified": "candidate",
                "last_good": "baseline", "rollback_attempted": "baseline" if exhausted else None,
                "failures": [now] * (3 if exhausted else 0), "transition": None,
                "child": record, "config": {"port": _free_port(), "health_interval": 0,
                    "health_failures": 1, "failure_budget": 3, "max_backoff": 0, "degraded_interval": 0},
            })
            with patch.object(service.time, "sleep"), patch.object(service, "prove_child", side_effect=service.ServiceError("dead")), \
                 patch.object(service, "stop_child", side_effect=stop_failure), \
                 patch.object(service, "rollback", return_value=None):
                service.monitor(store, store.read()["config"], record)
            state = store.read()
            assert state["child"] == record
            assert state["phase"] == "degraded"
            assert "stop failed" in state["diagnostic"]

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


# Real-test observation ceilings, not production wall-clock guarantees. File I/O
# and scheduling add overhead; wait_ready checks its deadline between iterations.
_PROBE_SECONDS = 5
_IDENTITY_SECONDS = 4 * _PROBE_SECONDS  # snapshot ps/lsof, group ps, listener lsof
_PRESTART_SECONDS = 5 + 5 * _PROBE_SECONDS  # throttle, two listeners, Node version, snapshot
_READY_SECONDS = 45
_READY_OBSERVATION = _READY_SECONDS + 2 * _IDENTITY_SECONDS + 2 + 1  # final readiness iteration


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


def maintenance_rehearsal_checks(python: Path, runtime_path: str):
    """Isolated old-supervisor replacement with proven parent and socket continuity."""
    import http.client
    python_image = str((python.parent.parent / "Resources/Python.app/Contents/MacOS/Python").resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="9router-maintenance-") as raw:
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
        uid = os.getuid()
        label = f"io.9router.selftest.maintenance.{uid}.{os.getpid()}.{int(time.time())}"
        guard_label = f"{label}.guard"
        port = _free_port()
        install_args = [str(RELEASE_SOURCE), "install", "--baseline", str(healthy), "--python", str(python),
                        "--node", str(node), "--env-file", str(env), "--schema-source", str(healthy),
                        "--service-dir", str(service_dir), "--bin-dir", str(bin_dir), "--releases-dir", str(releases_dir),
                        "--launch-agents", str(launch_agents), "--log-dir", str(logs), "--home", str(home),
                        "--data-dir", str(data), "--label", label, "--guard-label", guard_label, "--port", str(port),
                        "--runtime-path", runtime_path, "--hostname", "127.0.0.1", "--startup-timeout", str(_READY_SECONDS),
                        "--probation", "2", "--health-interval", ".25", "--health-failures", "2",
                        "--failure-budget", "3", "--max-backoff", "1", "--degraded-interval", "2",
                        "--guard-interval", ".5", "--bootstrap-attempts", "2"]
        _run(str(python), *install_args)
        store = service.StateStore(service_dir / "state.json")
        gateway_plist = service_dir / f"{label}.supervisor.plist"
        gateway_service = f"gui/{uid}/{label}"
        domain = f"gui/{uid}"
        state = store.read()
        original_script = bin_dir / "gateway_service.py"
        patched_bytes = SOURCE.read_bytes()
        baseline_bytes = subprocess.check_output(["git", "-C", str(ROOT), "show",
            "fac053ea2ec20dbfc44e519309eb4de86f86c7a9:scripts/service/gateway_service.py"])
        service.atomic_write(original_script, baseline_bytes, original_script.stat().st_mode & 0o777)
        wrapper = base / "baseline-wrapper.py"
        marker = base / "injected.json"
        maintenance = base / "ownership-maintenance.json"
        loaded = base / "loaded.json"
        readiness = base / "readiness.json"
        captured = base / "captured.json"
        wrapper.write_text(
            "import os,json,hashlib,types,time\nfrom pathlib import Path\n"
            f"source=Path({str(original_script)!r}); marker=Path({str(marker)!r}); sd=Path({str(service_dir)!r})\n"
            "content=source.read_bytes();m=types.ModuleType('scratch_service');m.__file__=str(source)\n"
            "exec(compile(content,str(source),'exec'),m.__dict__)\n"
            f"m.atomic_write(Path({str(loaded)!r}),json.dumps(dict(pid=os.getpid(),sha256=hashlib.sha256(content).hexdigest())).encode())\n"
            "orig=m.monitor; ready=m.wait_ready; start=m.start_selected; prove=m.prove_child\n"
            "def prove_child(*args,**kwargs):\n"
            " started=time.monotonic()\n"
            " try: return prove(*args,**kwargs)\n"
            " except m.ServiceError as e: print('prove failed',str(e),flush=True);raise\n"
            " finally: print('prove seconds',round(time.monotonic()-started,3),flush=True)\n"
            "def start_selected(*args,**kwargs):\n"
            " record=start(*args,**kwargs)\n"
            f" m.atomic_write(Path({str(captured)!r}),json.dumps(record).encode())\n"
            " return record\n"
            "def monitor(store,config,record):\n"
            " if not marker.exists():\n"
            "  assert m.process_snapshot(record['pid'])['ppid']==os.getpid()\n"
            "  with store.locked() as s:\n"
            "   assert s['child']==record\n"
            "   m.atomic_write(marker,json.dumps(record).encode())\n"
            "   s['child']=None; s['phase']='degraded'\n"
            "  return\n"
            " return orig(store,config,record)\n"
            "def wait_ready(*args,**kwargs):\n"
            " started=time.monotonic();print('ready started',args[0]['pid'],flush=True)\n"
            " result=ready(*args,**kwargs)\n"
            " print('ready finished',result,round(time.monotonic()-started,3),flush=True)\n"
            f" m.atomic_write(Path({str(readiness)!r}),json.dumps(dict(pid=os.getpid(),successes=kwargs.get('successes',3),result=result)).encode())\n"
            " return result\n"
            "m.monitor=monitor;m.wait_ready=wait_ready;m.start_selected=start_selected;m.prove_child=prove_child;m.supervise(sd)\n", encoding="utf-8")
        payload = plistlib.loads(gateway_plist.read_bytes())
        payload["ProgramArguments"] = [str(python), "-B", str(wrapper)]
        service.atomic_write(gateway_plist, plistlib.dumps(payload))
        final_plist = launch_agents / f"{label}.plist"
        guard_plist = launch_agents / f"{guard_label}.plist"
        service.atomic_write(final_plist, gateway_plist.read_bytes())
        # Fixture starts already installed: guard must never run migration/bootout.
        with store.locked() as state:
            state["install_transaction"] = {"phase": "committed", "loaded": "stable",
                "stable_plist": str(gateway_plist), "final_plist": str(final_plist)}
            state["guard"]["stable_plist"] = str(final_plist)
        jobs = [f"{domain}/{guard_label}", gateway_service]
        child = None
        helpers = []
        witness_stop = threading.Event()
        witness_ready = threading.Event()
        witness_errors = []
        samples = []
        witness = None

        def observe():
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            connection.auto_open = 0
            try:
                connection.connect()
                sock = connection.sock
                endpoint = sock.getsockname()
                while True:
                    connection.request("GET", "/api/health", headers={"Connection": "keep-alive"})
                    response = connection.getresponse()
                    assert response.status == 200 and json.loads(response.read())["ok"] is True
                    assert connection.sock is sock and sock.getsockname() == endpoint
                    samples.append((time.monotonic(), endpoint))
                    witness_ready.set()
                    if witness_stop.wait(1):
                        break
            except BaseException as error:
                witness_errors.append(error)
                witness_ready.set()
            finally:
                connection.close()

        def same_supervisor(expected):
            assert service.loaded_job_matches(gateway_service, payload["ProgramArguments"])
            assert service.loaded_job_pid(gateway_service) == expected["pid"]
            actual = service.process_snapshot(expected["pid"])
            assert all(actual[key] == expected[key] for key in ("pid", "start", "pgid", "session", "cwd"))
            assert actual["ppid"] == 1 and python_image in actual["texts"]

        def unknown_after(previous=0):
            state = store.read()
            return (state.get("child") is None and state.get("phase") == "degraded"
                    and state.get("diagnostic") == "Unknown process already owns gateway port"
                    and state.get("diagnostic_at", 0) > previous and state)

        def save_journal():
            service.atomic_write(maintenance, json.dumps(journal).encode())

        try:
            _run("/bin/launchctl", "bootstrap", domain, str(final_plist))
            _run("/bin/launchctl", "bootstrap", domain, str(guard_plist))
            started = time.monotonic()
            _wait(captured.exists, timeout=_PRESTART_SECONDS, message="baseline durable child capture")
            child = json.loads(captured.read_text())
            print("Maintenance capture seconds:", round(time.monotonic() - started, 3), flush=True)
            started = time.monotonic()
            _wait(marker.exists, timeout=_READY_OBSERVATION + 2 * _PROBE_SECONDS,
                  message="baseline readiness then parent-proved injection")
            assert json.loads(marker.read_text()) == child
            print("Maintenance readiness/injection seconds:", round(time.monotonic() - started, 3), flush=True)
            state = _wait(unknown_after, message="baseline unknown-listener degraded state")
            _wait(lambda: unknown_after(state["diagnostic_at"]), message="repeated baseline refusal")
            supervisor = service.process_snapshot(service.loaded_job_pid(gateway_service))
            assert json.loads(loaded.read_text()) == {"pid": supervisor["pid"], "sha256": hashlib.sha256(baseline_bytes).hexdigest()}
            service.prove_child(child, require_listener=True)
            assert service.process_snapshot(child["pid"])["ppid"] == supervisor["pid"]
            _wait(lambda: (store.read().get("guard_status") or {}).get("ok"), message="live independent guard")
            guard_pid = service.loaded_job_pid(jobs[0])
            guard_start = service.process_snapshot(guard_pid)["start"]
            state = store.read()
            bindings = {key: state.get(key) for key in
                        ("current", "qualified", "last_good", "config", "releases", "rollback_attempted", "install_transaction", "guard")}
            journal = {"phase": "prepared", "child": child, "original_supervisor": supervisor,
                       "bindings": bindings, "candidate_sha256": hashlib.sha256(patched_bytes).hexdigest(),
                       "plists": {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in (final_plist, guard_plist)},
                       "arguments": payload["ProgramArguments"], "guard_pid": guard_pid, "guard_start": guard_start}
            save_journal()
            assert maintenance.stat().st_mode & 0o777 == 0o600
            witness = threading.Thread(target=observe, name="maintenance-health")
            witness.start()
            assert witness_ready.wait(5), "No first health response"
            if witness_errors:
                raise witness_errors[0]
            same_supervisor(supervisor)
            service.atomic_write(original_script, patched_bytes, original_script.stat().st_mode & 0o777)
            assert hashlib.sha256(original_script.read_bytes()).hexdigest() == journal["candidate_sha256"]
            same_supervisor(supervisor)
            service.prove_child(child, require_listener=True)
            assert service.process_snapshot(child["pid"])["ppid"] == supervisor["pid"]
            assert unknown_after()
            journal.update(phase="script-installed", installation_barrier_at=time.time())
            save_journal()
            killed_at = time.monotonic()
            os.kill(supervisor["pid"], signal.SIGKILL)  # Never signal the gateway/group.
            successor_pid = _wait(lambda: (pid if (pid := service.loaded_job_pid(gateway_service))
                                          not in (None, supervisor["pid"]) else None),
                                  timeout=20, message="patched supervisor successor")
            _wait(lambda: json.loads(loaded.read_text()) == {"pid": successor_pid, "sha256": journal["candidate_sha256"]},
                  message="successor loaded patched bytes")
            successor = service.process_snapshot(successor_pid)
            same_supervisor(successor)
            state = _wait(lambda: unknown_after(journal["installation_barrier_at"]), message="successor unknown-listener refusal")
            _wait(lambda: unknown_after(state["diagnostic_at"]), message="repeated successor refusal")
            service.prove_child(child, require_listener=True)
            journal.update(phase="supervisor-replaced", successor=successor)
            save_journal()
            # Private resumable helper: kill before commit, then after atomic state
            # commit but before its journal marker. Every run rereads under lock.
            helper = base / "restore.py"
            helper.write_text(
                "import json,sys,time,hashlib,types\nfrom pathlib import Path\n"
                f"source=Path({str(original_script)!r}); journal_path=Path({str(maintenance)!r})\n"
                "m=types.ModuleType('repair');m.__file__=str(source);exec(compile(source.read_bytes(),str(source),'exec'),m.__dict__)\n"
                f"store=m.StateStore(Path({str(store.path)!r})); name={gateway_service!r}; guard={jobs[0]!r}\n"
                "j=json.loads(journal_path.read_text());assert j['installation_barrier_at']\n"
                "assert hashlib.sha256(source.read_bytes()).hexdigest()==j['candidate_sha256']\n"
                "def check(s):\n"
                " assert s.get('transition') is None\n"
                " assert all(s.get(k)==v for k,v in j['bindings'].items())\n"
                " assert s.get('child') in (None,j['child'])\n"
                " assert s['guard_status']['ok'] and time.time()-s['guard_status']['checked_at']<5\n"
                " assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in j['plists'].items())\n"
                " assert m.loaded_job_matches(name,j['arguments']) and m.loaded_job_pid(name)==j['successor']['pid']\n"
                " actual=m.process_snapshot(j['successor']['pid'])\n"
                " assert all(actual[k]==j['successor'][k] for k in ('pid','start','pgid','session','cwd'))\n"
                f" assert {python_image!r} in actual['texts']\n"
                " assert m.loaded_job_pid(guard)==j['guard_pid'] and m.process_snapshot(j['guard_pid'])['start']==j['guard_start']\n"
                " m.prove_child(j['child'],require_listener=True)\n"
                "def pause(phase):\n"
                " if sys.argv[1]==phase:\n"
                "  m.atomic_write(journal_path.with_name(phase+'.checkpoint'),phase.encode());time.sleep(60)\n"
                "check(store.read());pause('before')\n"
                "with store.locked() as s:\n"
                " check(s)\n"
                " if s.get('child') is None:\n"
                "  assert s['phase']=='degraded';s['child']=j['child']\n"
                "  m._diagnostic(s,'Proved existing child ownership restored; readiness pending')\n"
                " else: assert s['phase'] in ('degraded','healthy')\n"
                "pause('after')\n"
                "j['phase']='ownership-restored';m.atomic_write(journal_path,json.dumps(j).encode())\n",
                encoding="utf-8")
            for phase in ("before", "after", "resume"):
                process = subprocess.Popen([str(python), "-B", str(helper), phase],
                                           env={**os.environ, "HOME": str(home)}, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.PIPE, start_new_session=True)
                helpers.append(process)
                if phase == "resume":
                    _, errors = process.communicate(timeout=30)
                    assert process.returncode == 0, errors.decode()
                    break
                checkpoint = base / f"{phase}.checkpoint"
                def helper_paused():
                    assert process.poll() is None, process.stderr.read().decode()
                    return checkpoint.exists()
                _wait(helper_paused, timeout=30, message=f"helper {phase}-commit barrier")
                assert json.loads(maintenance.read_text())["phase"] == "supervisor-replaced"
                assert store.read().get("child") == (None if phase == "before" else child)
                os.kill(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
                assert process.returncode == -signal.SIGKILL
                if phase == "before":
                    # A newer unrelated update must survive the resumed locked write.
                    with store.locked() as state:
                        state["maintenance_test_sentinel"] = "concurrent-update"
                    _wait(lambda: unknown_after(), message="pre-commit interruption leaves refusal intact")
            assert json.loads(maintenance.read_text())["phase"] == "ownership-restored"
            _wait(lambda: store.read().get("phase") == "healthy" and store.read().get("child") == child,
                  timeout=_READY_OBSERVATION + float(bindings["config"]["degraded_interval"]),
                  message="retained-child recovery")
            assert json.loads(readiness.read_text()) == {"pid": successor_pid, "successes": 3, "result": True}
            assert store.read()["diagnostic"] == "Recovered retained child: healthy"
            assert store.read()["maintenance_test_sentinel"] == "concurrent-update"
            assert all(store.read().get(key) == value for key, value in bindings.items())
            same_supervisor(successor)
            service.prove_child(child, require_listener=True)
            assert service.listener_pids(port) == {child["pid"]}
            assert service.loaded_job_pid(jobs[0]) == guard_pid
            assert service.process_snapshot(guard_pid)["start"] == guard_start
            assert store.read()["guard_status"]["ok"]
            recovered_at = time.monotonic()
            _wait(lambda: samples and samples[-1][0] > recovered_at, timeout=5, message="same socket after recovery")
            assert any(sample[0] < killed_at for sample in samples)
            print("PASS maintenance:", json.dumps({"gateway_pid": child["pid"], "start": child["start"],
                  "pgid": child["pgid"], "supervisor_before": supervisor["pid"], "supervisor_after": successor_pid,
                  "guard_pid": guard_pid, "socket": samples[0][1], "health_responses": len(samples),
                  "helper_interruptions": ["before-commit", "after-commit-before-journal"], "ready_successes": 3}), flush=True)
        except BaseException:
            print("MAINTENANCE DEBUG", base, json.dumps(store.read()), file=sys.stderr)
            for diagnostic in logs.glob("*"):
                print(diagnostic.name, diagnostic.read_text(errors="replace")[-4000:], file=sys.stderr)
            raise
        finally:
            witness_stop.set()
            if witness is not None:
                witness.join(timeout=5)
            for process in helpers:
                if process.poll() is None:
                    os.kill(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
                process.stderr.close()
            for job in jobs:
                _bootout(job)
            # The missing-record failure path still owns the exact saved identity.
            record = child or (json.loads(captured.read_text()) if captured.exists() else store.read().get("child"))
            if record:
                service.stop_child(record, graceful=1)
                assert service._confirmed_record_gone(record)
            _wait(lambda: not service.listener_pids(port), timeout=5, message="maintenance listener cleanup")
            assert all(not service._loaded(job) for job in jobs)
            if witness is not None:
                assert not witness.is_alive(), "Health witness did not stop"
            if witness_errors:
                raise witness_errors[0]


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
            "--hostname", "127.0.0.1", "--startup-timeout", str(_READY_SECONDS), "--probation", "2",
            "--health-interval", ".25", "--health-failures", "2", "--failure-budget", "3",
            "--max-backoff", "1", "--degraded-interval", "2", "--guard-interval", ".5",
            "--bootstrap-attempts", "2",
        ]
        _run(str(python), *install_args)
        store = service.StateStore(service_dir / "state.json")
        gateway_plist = service_dir / f"{label}.supervisor.plist"
        final_gateway_plist = launch_agents / f"{label}.plist"
        guard_plist = launch_agents / f"{guard_label}.plist"
        # Healthy state can be committed by rollback inside the previous monitor.
        # Observe entry for this exact child before injecting its next failure.
        monitor_entry = base / "monitor-entry.json"
        supervisor_wrapper = base / "supervisor-observer.py"
        supervisor_wrapper.write_text(
            "import importlib.util,json,time\nfrom pathlib import Path\n"
            f"source=Path({str(bin_dir / 'gateway_service.py')!r}); marker=Path({str(monitor_entry)!r}); sd=Path({str(service_dir)!r})\n"
            "spec=importlib.util.spec_from_file_location('observed_service',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            "original=m.monitor;count=0\n"
            "def monitor(store,config,record):\n"
            " global count\n"
            " count+=1;m.atomic_write(marker,json.dumps(dict(child=record,entry=count)).encode())\n"
            " print(json.dumps(dict(at=time.time(),call='monitor',event='entry',child=record['pid'],entry=count)),flush=True)\n"
            " return original(store,config,record)\n"
            "m.monitor=monitor\n"
            "def traced(name):\n"
            " original=getattr(m,name)\n"
            " def call(*args,**kwargs):\n"
            "  started=time.monotonic();subject=(args[0] if name in ('_run_probe','listener_pids') else (args[0].get('pid') if args and isinstance(args[0],dict) else None))\n"
            "  print(json.dumps(dict(at=time.time(),call=name,event='start',subject=subject)),flush=True)\n"
            "  try:\n"
            "   result=original(*args,**kwargs)\n"
            "   detail=result if isinstance(result,(bool,int,type(None))) else None\n"
            "   print(json.dumps(dict(at=time.time(),call=name,event='return',seconds=round(time.monotonic()-started,3),result=detail)),flush=True)\n"
            "   return result\n"
            "  except BaseException as error:\n"
            "   print(json.dumps(dict(at=time.time(),call=name,event='error',seconds=round(time.monotonic()-started,3),error=str(error))),flush=True);raise\n"
            " return call\n"
            "for name in ('_run_probe','listener_pids','prove_child','wait_ready','monitor','rollback','stop_child','_record_failure'):\n"
            " setattr(m,name,traced(name))\n"
            "m.supervise(sd)\n", encoding="utf-8")
        supervisor_payload = plistlib.loads(gateway_plist.read_bytes())
        supervisor_payload["ProgramArguments"] = [str(python), "-B", str(supervisor_wrapper)]
        service.atomic_write(gateway_plist, plistlib.dumps(supervisor_payload))
        # Test-only guard wrapper pauses exactly after stable bootstrap and before
        # the loaded phase write; launchd restarts it after SIGKILL.
        guard_checkpoint = base / "guard-after-bootstrap.checkpoint"
        guard_wrapper = base / "guard-kill-wrapper.py"
        guard_wrapper.write_text(
            "import importlib.util,signal\nfrom pathlib import Path\n"
            f"source=Path({str(bin_dir / 'gateway_service.py')!r}); checkpoint=Path({str(guard_checkpoint)!r}); service_dir=Path({str(service_dir)!r})\n"
            "spec=importlib.util.spec_from_file_location('gateway_service_guard_kill',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            "original=m.bootstrap_with_fallback\n"
            "def stop(*args,**kwargs):\n result=original(*args,**kwargs)\n"
            " if not checkpoint.exists():\n"
            "  checkpoint.write_text(result)\n"
            "  signal.pause()  # Only the test SIGKILL/cleanup may release this boundary.\n"
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
        def monitored_child():
            state = store.read()
            if state.get("phase") != "healthy" or not state.get("child") or not monitor_entry.exists():
                return None
            entry = json.loads(monitor_entry.read_text())
            return state["child"] if entry["child"] == state["child"] and entry["entry"] > 0 else None
        try:
            # Real old direct job exists before the independent guard migrates it.
            _run("/bin/launchctl", "bootstrap", domain, str(fallback))
            _wait(lambda: service.health(port, .2), timeout=8, message="old direct job")
            old_direct_pid = service.loaded_job_pid(gateway_service)
            assert old_direct_pid in service.listener_pids(port)
            start = time.monotonic()
            _run("/bin/launchctl", "bootstrap", domain, str(guard_plist))
            _wait(guard_checkpoint.exists, timeout=15, message="guard post-bootstrap checkpoint")
            expected_arguments = plistlib.loads(gateway_plist.read_bytes())["ProgramArguments"]
            capture_started = time.monotonic()
            stable_child = _wait(lambda: store.read().get("child"),
                                 timeout=float(plistlib.loads(gateway_plist.read_bytes())["ThrottleInterval"]) + _PRESTART_SECONDS - 5,
                                 message="stable supervisor durable child capture")
            timings["stable_child_capture"] = time.monotonic() - capture_started
            assert stable_child["release"] == str(healthy)
            assert stable_child["release_digest"] == store.read()["releases"]["healthy"]["digest"]
            assert service.loaded_job_matches(gateway_service, expected_arguments)
            _wait(lambda: store.read().get("phase") == "healthy" and store.read().get("child") == stable_child,
                  timeout=_READY_OBSERVATION, message="stable supervisor completed readiness before guard kill")
            service.prove_child(stable_child, require_listener=True)
            assert service.health(port)
            stable_pid_before_guard_kill = service.loaded_job_pid(gateway_service)
            assert stable_pid_before_guard_kill is not None
            timings["stable_child_ready"] = time.monotonic() - capture_started
            print("Stable startup seconds:", json.dumps({key: round(timings[key], 3)
                  for key in ("stable_child_capture", "stable_child_ready")}), flush=True)
            assert store.read()["install_transaction"]["phase"] == "bootstrapping-stable"
            killed = _run("/bin/launchctl", "kill", "SIGKILL", guard_service, check=False)
            assert killed.returncode == 0, killed.stderr
            _wait(lambda: store.read().get("install_transaction", {}).get("phase") == "committed" and service.health(port, .2),
                  timeout=5 + _READY_SECONDS + _PROBE_SECONDS + _IDENTITY_SECONDS + 2 + 1,
                  message="guard-kill adoption migration")
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

            # Recorded-child supervisor replacement remains separate coverage;
            # missing-record maintenance below must send only one supervisor kill.
            _wait(lambda: store.read().get("phase") == "healthy", timeout=45, message="recorded child ready")
            retained = store.read()["child"]
            old_supervisor = service.loaded_job_pid(gateway_service)
            service.prove_child(retained, require_listener=True)
            assert old_supervisor is not None  # Child may already be orphaned by the preceding bootout.
            start = time.monotonic()
            os.kill(old_supervisor, signal.SIGKILL)
            _wait(lambda: service.loaded_job_pid(gateway_service) not in (None, old_supervisor),
                  timeout=20, message="recorded-child supervisor successor")
            _wait(lambda: store.read().get("phase") == "healthy" and service.health(port),
                  timeout=45, message="recorded-child restart health")
            assert store.read()["child"] == retained
            service.prove_child(retained, require_listener=True)
            timings["recorded_child_supervisor_kill"] = time.monotonic() - start

            maintenance_rehearsal_checks(python, runtime_path)

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
            rollback_phases = []
            def rolled_back():
                current = store.read()
                phase = (current["phase"], (current.get("child") or {}).get("pid"))
                if not rollback_phases or rollback_phases[-1][1:] != phase:
                    rollback_phases.append((round(time.monotonic() - start, 3), *phase))
                return current.get("transition") is None and current.get("current") == "healthy"
            # Keep production readiness for both hung target and healthy rollback.
            # Observe each stage separately: queued work includes the monitor's
            # in-flight proof, two release validations, reconciliation and stop.
            # Each stop allows TERM/KILL windows plus identity/absence proofs.
            stop_observation = 10 + 5 + 2 * _IDENTITY_SECONDS + 4 * _PROBE_SECONDS
            prepare_observation = (.25 + _IDENTITY_SECONDS + 2 + 2 * _PROBE_SECONDS
                                   + _PROBE_SECONDS + _IDENTITY_SECONDS + stop_observation
                                   + _PRESTART_SECONDS)
            try:
                def candidate_recorded():
                    rolled_back()
                    record = store.read().get("child")
                    return record and record.get("release") == str(hung)
                _wait(candidate_recorded, timeout=prepare_observation, message="hung candidate recorded")
                def rollback_recorded():
                    rolled_back()
                    record = store.read().get("child")
                    return record and record.get("release") == str(healthy)
                _wait(rollback_recorded,
                      timeout=_READY_OBSERVATION + _PROBE_SECONDS + _IDENTITY_SECONDS
                              + stop_observation + _PRESTART_SECONDS,
                      message="healthy rollback child recorded after hung readiness")
                _wait(rolled_back, timeout=_READY_OBSERVATION, message="hung-health rollback ready")
            finally:
                print("Hung-health phases:", json.dumps(rollback_phases), flush=True)
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
            prebind_previous = store.read().get("child")
            _wait(lambda: (record := store.read().get("child")) and record != prebind_previous
                  and record.get("release") == str(healthy),
                  timeout=prepare_observation + _READY_OBSERVATION + _PROBE_SECONDS
                          + _IDENTITY_SECONDS + stop_observation + _PRESTART_SECONDS,
                  message="prebind rollback child recorded")
            _wait(lambda: store.read().get("transition") is None and store.read().get("phase") == "healthy",
                  timeout=_READY_OBSERVATION, message="prebind rollback ready")
            timings["prebind_rollback"] = time.monotonic() - start
            assert store.read()["current"] == "healthy"
            assert service.health(port, .2)

            # Measure the exact identity/readiness cost used by the supervisor.
            # All scratch releases use the production 45s startup deadline.
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
            startup_timeout = float(store.read()["config"]["startup_timeout"])

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
            crash_previous = store.read().get("child")
            _wait(lambda: (record := store.read().get("child")) and record != crash_previous
                  and record.get("release") == str(healthy),
                  timeout=prepare_observation + _READY_OBSERVATION + float(store.read()["config"]["probation"])
                          + _IDENTITY_SECONDS + 2 + _PROBE_SECONDS + _IDENTITY_SECONDS
                          + stop_observation + _PRESTART_SECONDS,
                  message="post-ready crash rollback child recorded")
            _wait(lambda: store.read().get("transition") is None and store.read().get("current") == "healthy"
                  and store.read().get("phase") == "healthy",
                  timeout=_READY_OBSERVATION, message="post-ready crash rollback ready")
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
            config = store.read()["config"]
            failure_budget = int(config["failure_budget"])
            detection_observation = int(config["health_failures"]) * (float(config["health_interval"])
                                                                     + _IDENTITY_SECONDS + 2)
            failure_window = service._record_failure.__defaults__[0]
            observed_failures = []
            def crash_state():
                current = store.read()
                failures = current.get("failures", [])
                if failures != observed_failures:
                    print("Crash failures:", json.dumps({"at": time.time(), "phase": current["phase"],
                          "child": (current.get("child") or {}).get("pid"), "times": failures}), flush=True)
                    assert current.get("rollback_attempted") or all(stamp in failures for stamp in observed_failures), (
                        "Crash budget timestamps expired before exhaustion", failure_window, observed_failures, failures)
                    observed_failures[:] = failures
                if observed_failures and len(observed_failures) < failure_budget and not current.get("rollback_attempted"):
                    assert time.time() - observed_failures[0] < failure_window, (
                        "Crash injection cannot exercise budget within failure window", failure_window, observed_failures)
                return current
            for attempt in range(failure_budget):
                failed_record = _wait(monitored_child, timeout=_READY_OBSERVATION,
                                      message=f"crashloop monitor entry {attempt + 1}")
                assert failed_record["release"] == str(crashloop)
                failures_before = list(crash_state().get("failures", []))
                service.signal_child(failed_record, signal.SIGKILL, require_listener=True)
                _wait(lambda: len(crash_state().get("failures", [])) > len(failures_before),
                      timeout=detection_observation, message=f"crash {attempt + 1} durably counted")
                target = crashloop if attempt + 1 < failure_budget else healthy
                def replacement_recorded():
                    record = crash_state().get("child")
                    return (record if record and record["pid"] != failed_record["pid"]
                            and record["release"] == str(target) else None)
                replacement = _wait(replacement_recorded,
                                    timeout=stop_observation + float(config["max_backoff"])
                                            + _PROBE_SECONDS + _IDENTITY_SECONDS + _PRESTART_SECONDS,
                                    message=f"crash {attempt + 1} replacement recorded")
                def replacement_ready():
                    current = crash_state()
                    return (current.get("transition") is None and current.get("phase") == "healthy"
                            and current.get("current") == target.name and current.get("child") == replacement)
                _wait(replacement_ready, timeout=_READY_OBSERVATION,
                      message=f"crash {attempt + 1} replacement ready")
            timings["post_probation_crash_rollback"] = time.monotonic() - qualified_at
            assert store.read()["rollback_attempted"] == "healthy"
            assert service.health(port, .2)

            # The fallback then fails while the budget remains exhausted. It must
            # enter degraded state, leave no child, wait, then retry slowly.
            baseline_record = _wait(monitored_child, timeout=_READY_OBSERVATION,
                                    message="rollback baseline monitor entry before failure")
            assert baseline_record["release"] == str(healthy)
            degraded_interval = float(store.read()["config"]["degraded_interval"])
            service.signal_child(baseline_record, signal.SIGKILL, require_listener=True)
            _wait(lambda: store.read().get("phase") == "degraded" and store.read().get("child") is None,
                  timeout=detection_observation + stop_observation, interval=.02,
                  message="failing baseline degraded state")
            assert store.read()["diagnostic"] == "Qualified fallback crash-loop exhausted; slow restart"
            degraded_at = float(store.read()["diagnostic_at"])
            _wait(lambda: (store.read().get("child") or {}).get("pid") not in (None, baseline_record["pid"]),
                  timeout=degraded_interval + _PRESTART_SECONDS, interval=.02,
                  message="slow degraded baseline retry")
            retry_recorded_at = time.time()
            timings["failing_baseline_slow_retry"] = retry_recorded_at - degraded_at
            assert timings["failing_baseline_slow_retry"] >= degraded_interval - .25
            _wait(lambda: store.read().get("phase") == "healthy" and service.health(port, .2),
                  timeout=_READY_OBSERVATION, message="baseline healthy after slow retry")

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
