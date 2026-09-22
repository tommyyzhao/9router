#!/usr/bin/env python3
"""Dependency-free gateway self-healing checks.

Default mode is offline and cannot call launchctl.  Real launchd tests require
--real-launchd plus a private temporary HOME and approved scratch ports.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
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
    node.write_text("#!/bin/sh\n", encoding="utf-8")
    node.chmod(0o700)
    env = base / "stable.env"
    env.write_text("SECRET=not-printed\n", encoding="utf-8")
    return release, node, env


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real-launchd", action="store_true")
    args = parser.parse_args()
    offline_checks()
    if args.real_launchd:
        raise AssertionError("real launchd checks not implemented yet")
    print("PASS offline: atomic state/locks, release/schema/env binding, symlink rejection, identity/title/PID/group/listener checks")


if __name__ == "__main__":
    main()
