#!/usr/bin/env python3
"""Stable 9Router gateway supervisor and independent launchd guard.

No provider request is used as a health signal.  The supervisor owns exactly one
release child; the guard only restores an absent supervisor LaunchAgent.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import plistlib
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterator

STATE_VERSION = 1
REQUIRED_RELEASE_FILES = ("server.js", "custom-server.js", ".next/BUILD_ID")
SCHEMA_PATHS = (
    "src/lib/db/migrations",
    "src/lib/db/schema.js",
    "src/lib/db/migrate.js",
)


class ServiceError(RuntimeError):
    pass


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, content: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


@contextlib.contextmanager
def exclusive_lock(path: Path, nonblocking: bool = False) -> Iterator[int]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
        try:
            fcntl.flock(descriptor, flags)
        except BlockingIOError as error:
            raise ServiceError(f"Lock is already held: {path}") from error
        yield descriptor
    finally:
        os.close(descriptor)


class StateStore:
    """Generation-checked, flocked, atomically replaced JSON state."""

    def __init__(self, path: Path):
        self.path = path
        self.lock_path = path.with_suffix(path.suffix + ".lock")

    @contextlib.contextmanager
    def locked(self) -> Iterator[dict[str, Any]]:
        with exclusive_lock(self.lock_path):
            state = self.read_unlocked()
            generation = state["generation"]
            yield state
            current = self.read_unlocked()
            if current["generation"] != generation:
                raise ServiceError("Stale state generation; refusing overwrite")
            state["generation"] = generation + 1
            self._write_unlocked(state)

    def read(self) -> dict[str, Any]:
        with exclusive_lock(self.lock_path):
            return self.read_unlocked()

    def read_unlocked(self) -> dict[str, Any]:
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ServiceError(f"Missing state: {self.path}") from error
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ServiceError(f"Unreadable state: {self.path}: {error}") from error
        if not isinstance(state, dict) or state.get("version") != STATE_VERSION:
            raise ServiceError("Unsupported or corrupt service state")
        if not isinstance(state.get("generation"), int) or state["generation"] < 0:
            raise ServiceError("Invalid state generation")
        return state

    def create(self, state: dict[str, Any]) -> None:
        if self.path.exists():
            raise ServiceError(f"State already exists: {self.path}")
        state = dict(state)
        state.update(version=STATE_VERSION, generation=0)
        with exclusive_lock(self.lock_path):
            if self.path.exists():
                raise ServiceError(f"State already exists: {self.path}")
            self._write_unlocked(state)

    def _write_unlocked(self, state: dict[str, Any]) -> None:
        payload = (json.dumps(state, sort_keys=True, indent=2) + "\n").encode()
        atomic_write(self.path, payload, 0o600)


def _hash_file(path: Path, digest: "hashlib._Hash") -> None:
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)


def fingerprint_tree(root: Path) -> str:
    root = root.resolve(strict=True)
    digest = hashlib.sha256()
    for entry in sorted(root.rglob("*")):
        relative = entry.relative_to(root).as_posix().encode()
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ServiceError(f"Release contains symlink: {entry.relative_to(root)}")
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ServiceError(f"Release contains special file: {entry.relative_to(root)}")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        file_digest = hashlib.sha256()
        _hash_file(entry, file_digest)
        digest.update(file_digest.digest())
    return digest.hexdigest()


def fingerprint_schema(source: Path) -> str:
    source = source.resolve(strict=True)
    digest = hashlib.sha256()
    found = False
    for relative_name in SCHEMA_PATHS:
        candidate = source / relative_name
        if not candidate.exists():
            continue
        entries = [candidate] if candidate.is_file() else sorted(candidate.rglob("*"))
        for entry in entries:
            if entry.is_dir():
                continue
            if entry.is_symlink() or not entry.is_file():
                raise ServiceError(f"Invalid schema source entry: {entry}")
            relative = entry.relative_to(source).as_posix().encode()
            digest.update(len(relative).to_bytes(8, "big"))
            digest.update(relative)
            _hash_file(entry, digest)
            found = True
    if not found:
        raise ServiceError("No database schema sources found")
    return digest.hexdigest()


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    _hash_file(path, digest)
    return digest.hexdigest()


def validate_release(
    release: Path,
    releases_dir: Path,
    node: Path,
    env_file: Path,
    schema_digest: str,
    expected: dict[str, Any] | None = None,
) -> dict[str, Any]:
    releases_dir = releases_dir.resolve(strict=True)
    release = release.resolve(strict=True)
    try:
        release.relative_to(releases_dir)
    except ValueError as error:
        raise ServiceError("Release must be contained by the private releases directory") from error
    if release == releases_dir or release.is_symlink():
        raise ServiceError("Release must be a real child directory")
    for relative in REQUIRED_RELEASE_FILES:
        candidate = release / relative
        if candidate.is_symlink() or not candidate.is_file():
            raise ServiceError(f"Missing regular release file: {relative}")
    node = node.resolve(strict=True)
    if not node.is_file() or not os.access(node, os.X_OK):
        raise ServiceError(f"Node executable is invalid: {node}")
    env_file = env_file.resolve(strict=True)
    if not env_file.is_file() or env_file.is_symlink():
        raise ServiceError("Stable environment must be a regular file")
    build_id = (release / ".next/BUILD_ID").read_text(encoding="utf-8").strip()
    if not build_id or "\n" in build_id:
        raise ServiceError("Invalid Next build ID")
    node_digest = file_digest(node)
    try:
        node_version = subprocess.run([str(node), "--version"], stdin=subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                      timeout=5, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceError(f"Cannot verify Node version: {error}") from error
    record = {
        "path": str(release),
        "digest": fingerprint_tree(release),
        "build_id": build_id,
        "node": str(node),
        "node_digest": node_digest,
        "node_version": node_version,
        "env_file": str(env_file),
        "env_digest": file_digest(env_file),
        "schema_digest": schema_digest,
    }
    if expected is not None and record != expected:
        raise ServiceError("Validated release or stable environment changed")
    return record


def _run_probe(args: list[str], timeout: float = 5) -> str:
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ServiceError(f"Identity probe failed: {args[0]}: {error}") from error
    if result.returncode:
        detail = result.stderr.strip().replace("\n", " ")[:500]
        raise ServiceError(f"Identity probe failed ({result.returncode}): {detail}")
    return result.stdout


def process_snapshot(pid: int, ps: str = "/bin/ps", lsof: str = "/usr/sbin/lsof") -> dict[str, Any]:
    if not isinstance(pid, int) or pid <= 1:
        raise ServiceError("Invalid child PID")
    line = _run_probe([ps, "-o", "pid=,ppid=,pgid=,sess=,lstart=", "-p", str(pid)]).strip()
    fields = line.split(None, 4)
    if len(fields) != 5 or int(fields[0]) != pid:
        raise ServiceError("Process identity disappeared")
    ppid, pgid, session = map(int, fields[1:4])
    start = fields[4].strip()
    paths = _run_probe([lsof, "-a", "-p", str(pid), "-d", "cwd,txt", "-Fn"]).splitlines()
    cwd = None
    texts: list[str] = []
    kind = None
    for item in paths:
        if item.startswith("f"):
            kind = item[1:]
        elif item.startswith("n"):
            if kind == "cwd":
                cwd = str(Path(item[1:]).resolve())
            elif kind == "txt":
                texts.append(str(Path(item[1:]).resolve()))
    if cwd is None or not texts:
        raise ServiceError("Process cwd/executable identity unavailable")
    return {"pid": pid, "ppid": ppid, "pgid": pgid, "session": session,
            "start": start, "cwd": cwd, "texts": texts}


def process_group(ps: str, pgid: int) -> dict[int, tuple[int, int, int]]:
    output = _run_probe([ps, "-axo", "pid=,ppid=,pgid=,sess="])
    result: dict[int, tuple[int, int, int]] = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) == 4 and int(fields[2]) == pgid:
            result[int(fields[0])] = (int(fields[1]), int(fields[2]), int(fields[3]))
    return result


def listener_pids(port: int, lsof: str = "/usr/sbin/lsof") -> set[int]:
    try:
        result = subprocess.run([lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ServiceError(f"Listener probe failed: {error}") from error
    if result.returncode not in (0, 1):
        raise ServiceError(f"Listener probe failed ({result.returncode})")
    return {int(line) for line in result.stdout.splitlines() if line.strip().isdigit()}


def capture_child_identity(pid: int, release: dict[str, Any], port: int,
                           ps: str = "/bin/ps", lsof: str = "/usr/sbin/lsof") -> dict[str, Any]:
    snapshot = process_snapshot(pid, ps, lsof)
    expected_node = str(Path(release["node"]).resolve())
    expected_cwd = str(Path(release["path"]).resolve())
    if snapshot["cwd"] != expected_cwd or expected_node not in snapshot["texts"]:
        raise ServiceError("Started child has unexpected executable or cwd")
    if snapshot["pgid"] != pid:
        raise ServiceError("Started child lacks its own process group")
    if snapshot["session"] not in (0, pid):
        # launchd descendants can report session 0; start_new_session children
        # report their PID. No other session identity is accepted.
        raise ServiceError("Started child lacks an owned session")
    return {
        "pid": pid, "start": snapshot["start"], "pgid": snapshot["pgid"],
        "session": snapshot["session"], "node": expected_node, "cwd": expected_cwd,
        "release": release["path"], "release_digest": release["digest"], "port": port,
    }


def prove_child(record: dict[str, Any], require_listener: bool = True,
                ps: str = "/bin/ps", lsof: str = "/usr/sbin/lsof") -> set[int]:
    snapshot = process_snapshot(record["pid"], ps, lsof)
    for key in ("start", "pgid", "session", "cwd"):
        if snapshot[key] != record[key]:
            raise ServiceError(f"Child identity mismatch: {key}")
    if record["node"] not in snapshot["texts"]:
        raise ServiceError("Child executable identity mismatch")
    if record["pgid"] != record["pid"]:
        raise ServiceError("Child process group is not privately owned")
    members = process_group(ps, record["pgid"])
    if record["pid"] not in members:
        raise ServiceError("Child process group disappeared")
    for member, (_, _, session) in members.items():
        if session != record["session"]:
            raise ServiceError("Process group contains a different session")
        cursor = member
        seen: set[int] = set()
        while cursor != record["pid"]:
            if cursor in seen or cursor not in members:
                raise ServiceError("Process group contains an unrelated process")
            seen.add(cursor)
            cursor = members[cursor][0]
    listeners = listener_pids(record["port"], lsof)
    if require_listener and not listeners:
        raise ServiceError("Expected listener is absent")
    if listeners and not listeners.issubset(members):
        raise ServiceError("Port is owned by an unknown process")
    return members.keys()


def signal_child(record: dict[str, Any], sig: int, require_listener: bool = False,
                 ps: str = "/bin/ps", lsof: str = "/usr/sbin/lsof") -> None:
    # Re-prove immediately before signalling; stale/reused PIDs fail closed.
    prove_child(record, require_listener=require_listener, ps=ps, lsof=lsof)
    os.killpg(record["pgid"], sig)


def health(port: int, timeout: float = 2.0) -> bool:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        if response.status != 200:
            return False
        body = response.read(4096)
        return json.loads(body).get("ok") is True
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def _now() -> float:
    return time.time()


def _diagnostic(state: dict[str, Any], message: str) -> None:
    state["diagnostic"] = message[:1000]
    state["diagnostic_at"] = _now()


def child_command(release: dict[str, Any]) -> list[str]:
    return [release["node"], f"--env-file={release['env_file']}",
            str(Path(release["path"]) / "custom-server.js")]


def spawn_child(release: dict[str, Any], port: int, hostname: str, data_dir: Path,
                home: Path, log_path: Path, start_gate: tuple[int, int] | None = None,
                extra_environment: dict[str, str] | None = None) -> subprocess.Popen[bytes]:
    environment = os.environ.copy()
    environment.update({"HOSTNAME": hostname, "PORT": str(port), "HOME": str(home),
                        "DATA_DIR": str(data_dir)})
    environment.update(extra_environment or {})
    log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    log = log_path.open("ab", buffering=0)
    try:
        if start_gate is None:
            return subprocess.Popen(child_command(release), cwd=release["path"], env=environment,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                    start_new_session=True)
        read_fd, write_fd = start_gate
        # Node itself waits before loading custom-server.js, so its exact identity
        # is durable before any listener can bind. Pipe carries one non-secret byte.
        gate = ("const fs=require('fs');const b=Buffer.alloc(1);"
                f"if(fs.readSync({read_fd},b,0,1,null)!==1||b[0]!==49)process.exit(125);"
                "require('module').runMain()")
        command = [release["node"], f"--env-file={release['env_file']}", "-e", gate,
                   str(Path(release["path"]) / "custom-server.js")]
        return subprocess.Popen(command, cwd=release["path"], env=environment,
                                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True, pass_fds=(read_fd,))
    finally:
        log.close()


def wait_ready(record: dict[str, Any], deadline_seconds: float, successes: int = 3,
               interval: float = 1.0) -> bool:
    deadline = time.monotonic() + deadline_seconds
    consecutive = 0
    while time.monotonic() < deadline:
        try:
            prove_child(record, require_listener=False)
        except ServiceError:
            return False
        if health(record["port"]):
            try:
                prove_child(record, require_listener=True)
            except ServiceError:
                return False
            consecutive += 1
            if consecutive >= successes:
                return True
        else:
            consecutive = 0
        time.sleep(interval)
    return False


def wait_gone(record: dict[str, Any], timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            process_snapshot(record["pid"])
        except ServiceError:
            return True
        time.sleep(.1)
    return False


def stop_child(record: dict[str, Any], graceful: float = 10.0) -> None:
    signal_child(record, signal.SIGTERM, require_listener=False)
    if wait_gone(record, graceful):
        return
    signal_child(record, signal.SIGKILL, require_listener=False)
    if not wait_gone(record, 5):
        raise ServiceError("Owned child survived SIGKILL")


def _record_failure(state: dict[str, Any], reason: str, window: float = 120.0) -> int:
    now = _now()
    failures = [value for value in state.get("failures", [])
                if isinstance(value, (int, float)) and value >= now - window]
    failures.append(now)
    state["failures"] = failures
    _diagnostic(state, reason)
    return len(failures)


def _runtime_release(state: dict[str, Any], key: str) -> dict[str, Any]:
    releases = state.get("releases")
    if not isinstance(releases, dict) or not isinstance(releases.get(key), dict):
        raise ServiceError(f"State has no validated {key} release")
    return releases[key]


def reconcile_record(store: StateStore, port: int) -> dict[str, Any] | None:
    state = store.read()
    record = state.get("child")
    listeners = listener_pids(port)
    if record is None:
        if listeners:
            raise ServiceError("Unknown process already owns gateway port")
        return None
    if not isinstance(record, dict):
        raise ServiceError("Corrupt child identity in state")
    try:
        prove_child(record, require_listener=bool(listeners))
    except ServiceError as error:
        # Never erase ambiguous live identity. A dead PID with no listener is safe
        # to clear; stale/reused PID or unknown listener remains degraded.
        if listeners:
            raise ServiceError(f"Ambiguous recorded child/listener: {error}") from error
        try:
            process_snapshot(record.get("pid"))
        except ServiceError:
            with store.locked() as locked:
                if locked.get("child") == record:
                    locked["child"] = None
            return None
        raise ServiceError(f"Ambiguous live recorded child: {error}") from error
    return record


def start_selected(store: StateStore, release: dict[str, Any], config: dict[str, Any],
                   phase: str) -> dict[str, Any]:
    validate_release(Path(release["path"]), Path(config["releases_dir"]),
                     Path(release["node"]), Path(release["env_file"]),
                     release["schema_digest"], release)
    port = int(config["port"])
    if listener_pids(port):
        raise ServiceError("Unknown process owns gateway port before start")
    read_fd, write_fd = os.pipe()
    process = spawn_child(release, port, config["hostname"], Path(config["data_dir"]),
                          Path(config["home"]), Path(config["child_log"]), (read_fd, write_fd))
    os.close(read_fd)
    try:
        record = capture_child_identity(process.pid, release, port)
        with store.locked() as state:
            if state.get("child") is not None:
                raise ServiceError("Concurrent child appeared during start")
            state["child"] = record
            state["phase"] = phase
        os.write(write_fd, b"1")
        return record
    except BaseException:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
        raise
    finally:
        os.close(write_fd)


def recover_interrupted(store: StateStore) -> None:
    """Normalize persisted transition phases before the monitor loop."""
    with store.locked() as state:
        transition = state.get("transition")
        if not transition:
            return
        phase = transition.get("phase")
        if phase in {"queued", "stopping-current", "starting-candidate", "candidate-ready", "probation"}:
            transition["phase"] = phase
            _diagnostic(state, f"Recovering interrupted transition phase {phase}")
        elif phase not in {"rollback-starting", "rollback-probation"}:
            state["phase"] = "degraded"
            _diagnostic(state, f"Unknown transition phase: {phase}")


def rollback(store: StateStore, config: dict[str, Any], reason: str) -> dict[str, Any] | None:
    state = store.read()
    transition = state.get("transition") or {}
    target_name = transition.get("rollback") or state.get("last_good") or state.get("qualified")
    if not target_name:
        with store.locked() as locked:
            locked["phase"] = "degraded"
            _diagnostic(locked, f"No rollback baseline: {reason}")
        return None
    current = reconcile_record(store, int(config["port"]))
    if current is not None:
        stop_child(current)
        with store.locked() as locked:
            locked["child"] = None
    with store.locked() as locked:
        locked["phase"] = "rollback-starting"
        if locked.get("transition"):
            locked["transition"]["phase"] = "rollback-starting"
        _diagnostic(locked, reason)
    baseline = _runtime_release(store.read(), target_name)
    record = start_selected(store, baseline, config, "rollback-starting")
    if not wait_ready(record, float(config["startup_timeout"])):
        with contextlib.suppress(ServiceError):
            stop_child(record)
        with store.locked() as locked:
            locked["child"] = None
            locked["phase"] = "degraded"
            _record_failure(locked, "Qualified rollback release failed readiness")
        return None
    with store.locked() as locked:
        locked["current"] = target_name
        locked["qualified"] = target_name
        locked["transition"] = None
        locked["phase"] = "healthy"
        if not reason.startswith("Crash-loop budget"):
            locked["failures"] = []
        locked["child"] = record
        _diagnostic(locked, f"Rollback healthy: {target_name}")
    return record


def apply_transition(store: StateStore, config: dict[str, Any]) -> dict[str, Any] | None:
    state = store.read()
    transition = state.get("transition")
    if not transition:
        return reconcile_record(store, int(config["port"]))
    target_name = transition.get("target")
    rollback_name = transition.get("rollback")
    if target_name not in state.get("releases", {}) or rollback_name not in state.get("releases", {}):
        raise ServiceError("Transition references an unknown release")
    target = _runtime_release(state, target_name)
    baseline = _runtime_release(state, rollback_name)
    if target["schema_digest"] != baseline["schema_digest"]:
        raise ServiceError("Database schema digest changed; automatic promotion blocked")
    # Revalidate target and rollback before stopping the healthy child.
    for release in (target, baseline):
        validate_release(Path(release["path"]), Path(config["releases_dir"]),
                         Path(release["node"]), Path(release["env_file"]),
                         release["schema_digest"], release)
    record = reconcile_record(store, int(config["port"]))
    phase = transition.get("phase")
    if phase in {"queued", "stopping-current"}:
        with store.locked() as locked:
            locked["phase"] = "stopping-current"
            locked["transition"]["phase"] = "stopping-current"
        if record:
            stop_child(record)
            with store.locked() as locked:
                locked["child"] = None
        phase = "starting-candidate"
    if phase in {"starting-candidate", "candidate-ready", "probation"}:
        record = reconcile_record(store, int(config["port"]))
        if record is None:
            with store.locked() as locked:
                locked["phase"] = "starting-candidate"
                locked["transition"]["phase"] = "starting-candidate"
            record = start_selected(store, target, config, "starting-candidate")
        if not wait_ready(record, float(config["startup_timeout"])):
            return rollback(store, config, "Candidate failed startup readiness")
        with store.locked() as locked:
            locked["phase"] = "probation"
            locked["transition"]["phase"] = "probation"
            locked["transition"].setdefault("probation_started", _now())
        deadline = _now() + float(config["probation"])
        while _now() < deadline:
            time.sleep(float(config["health_interval"]))
            try:
                prove_child(record, require_listener=True)
            except ServiceError as error:
                return rollback(store, config, f"Candidate identity failed probation: {error}")
            if not health(int(config["port"])):
                return rollback(store, config, "Candidate liveness failed probation")
        with store.locked() as locked:
            locked["last_good"] = locked["qualified"]
            locked["current"] = target_name
            locked["qualified"] = target_name
            locked["transition"] = None
            locked["phase"] = "healthy"
            locked["failures"] = []
            _diagnostic(locked, f"Promotion qualified: {target_name}")
        return record
    if phase in {"rollback-starting", "rollback-probation"}:
        return rollback(store, config, "Resuming interrupted rollback")
    raise ServiceError(f"Unsupported transition phase: {phase}")


def monitor(store: StateStore, config: dict[str, Any], record: dict[str, Any]) -> None:
    failures = 0
    while True:
        time.sleep(float(config["health_interval"]))
        if store.read().get("transition"):
            return
        try:
            prove_child(record, require_listener=True)
            alive = health(int(config["port"]))
        except ServiceError:
            alive = False
        failures = 0 if alive else failures + 1
        if failures < int(config["health_failures"]):
            continue
        with store.locked() as state:
            count = _record_failure(state, "Child exited or local liveness failed")
        if count >= int(config["failure_budget"]):
            state = store.read()
            if state.get("current") in {state.get("qualified"), state.get("last_good")}:
                with store.locked() as locked:
                    locked["phase"] = "degraded"
                    _diagnostic(locked, "Qualified baseline crash-loop exhausted; slow retry only")
                time.sleep(float(config["degraded_interval"]))
                return
            rollback(store, config, "Crash-loop budget exhausted")
            return
        with contextlib.suppress(ServiceError):
            stop_child(record)
        with store.locked() as state:
            state["child"] = None
            state["phase"] = "restarting"
        time.sleep(min(2 ** max(0, count - 1), float(config["max_backoff"])))
        return


def supervise(service_dir: Path) -> None:
    store = StateStore(service_dir / "state.json")
    with exclusive_lock(service_dir / "supervisor.lock", nonblocking=True):
        recover_interrupted(store)
        while True:
            try:
                config = store.read()["config"]
                record = apply_transition(store, config)
                if record is None:
                    state = store.read()
                    release = _runtime_release(state, state["current"])
                    record = start_selected(store, release, config, "starting")
                    if not wait_ready(record, float(config["startup_timeout"])):
                        with contextlib.suppress(ServiceError):
                            stop_child(record)
                        with store.locked() as locked:
                            locked["child"] = None
                            count = _record_failure(locked, "Current release failed startup")
                            locked["phase"] = "degraded" if count >= int(config["failure_budget"]) else "restarting"
                        if count >= int(config["failure_budget"]):
                            time.sleep(float(config["degraded_interval"]))
                        else:
                            time.sleep(min(2 ** (count - 1), float(config["max_backoff"])))
                        continue
                    with store.locked() as locked:
                        locked["phase"] = "healthy"
                        _diagnostic(locked, f"Healthy: {locked['current']}")
                monitor(store, config, record)
            except ServiceError as error:
                with contextlib.suppress(ServiceError):
                    with store.locked() as state:
                        state["phase"] = "degraded"
                        _diagnostic(state, str(error))
                time.sleep(float(store.read().get("config", {}).get("degraded_interval", 30)))


def launchctl(*args: str, timeout: float = 20.0) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(["/bin/launchctl", *args], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                              timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ServiceError(f"launchctl {' '.join(args[:2])} failed: {error}") from error


def loaded_job_pid(service: str) -> int | None:
    result = launchctl("print", service, timeout=5)
    if result.returncode:
        return None
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("pid = ") and stripped[6:].isdigit():
            return int(stripped[6:])
    return None


def _loaded(service: str) -> bool:
    return launchctl("print", service, timeout=5).returncode == 0


def validate_plist(plist: Path, service: str, expected_arguments: list[str] | None = None,
                   expected_digest: str | None = None) -> None:
    if not plist.is_file() or plist.is_symlink():
        raise ServiceError(f"plist unavailable: {plist}")
    content = plist.read_bytes()
    if expected_digest and hashlib.sha256(content).hexdigest() != expected_digest:
        raise ServiceError("Fallback plist digest changed")
    try:
        payload = plistlib.loads(content)
    except Exception as error:
        raise ServiceError(f"Invalid plist: {plist}: {error}") from error
    expected_label = service.rsplit("/", 1)[-1]
    if payload.get("Label") != expected_label:
        raise ServiceError("Plist Label does not match guarded service")
    arguments = payload.get("ProgramArguments")
    if not isinstance(arguments, list) or not arguments:
        raise ServiceError("Plist has no ProgramArguments")
    if expected_arguments is not None and arguments != expected_arguments:
        raise ServiceError("Plist ProgramArguments changed")


def loaded_job_matches(service: str, expected_arguments: list[str]) -> bool:
    result = launchctl("print", service, timeout=5)
    if result.returncode:
        return False
    # launchctl print renders each argument on its own; exact membership plus
    # argument count avoids adopting a same-label unrelated job.
    return all(argument in result.stdout for argument in expected_arguments)


def bootstrap_one(domain: str, service: str, plist: Path, name: str,
                  attempts: int = 3, expected_digest: str | None = None,
                  expected_arguments: list[str] | None = None) -> str:
    errors: list[str] = []
    validate_plist(plist, service, expected_arguments, expected_digest)
    if expected_arguments and loaded_job_matches(service, expected_arguments):
        return name
    for attempt in range(attempts):
        result = launchctl("bootstrap", domain, str(plist))
        if result.returncode == 0 and _loaded(service):
            return name
        if _loaded(service):
            raise ServiceError("A gateway job became loaded during bootstrap")
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")[:500]
        errors.append(f"{name} bootstrap {attempt + 1} exit={result.returncode}: {detail}")
        time.sleep(min(2 ** attempt, 4))
    raise ServiceError("; ".join(errors))


def bootstrap_with_fallback(domain: str, service: str, stable_plist: Path,
                            fallback_plist: Path | None, attempts: int = 3) -> str:
    try:
        return bootstrap_one(domain, service, stable_plist, "stable", attempts)
    except ServiceError as stable_error:
        if fallback_plist is None or _loaded(service):
            raise
        try:
            return bootstrap_one(domain, service, fallback_plist, "fallback", attempts)
        except ServiceError as fallback_error:
            raise ServiceError(f"{stable_error}; {fallback_error}") from fallback_error


def pid_descends_from(pid: int, ancestor: int, ps: str = "/bin/ps") -> bool:
    output = _run_probe([ps, "-axo", "pid=,ppid="])
    parents = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) == 2:
            parents[int(fields[0])] = int(fields[1])
    seen = set()
    while pid != ancestor:
        if pid in seen or pid not in parents or pid <= 1:
            return False
        seen.add(pid)
        pid = parents[pid]
    return True


def prove_install_health(store: StateStore, expected: str, timeout: float) -> bool:
    state = store.read()
    record = state.get("child")
    listeners = listener_pids(int(state["config"]["port"]))
    if not listeners:
        return False
    if expected == "stable":
        if not isinstance(record, dict):
            return False
        release = _runtime_release(state, state["current"])
        if record.get("release") != release["path"] or record.get("release_digest") != release["digest"]:
            return False
        try:
            prove_child(record, require_listener=True)
        except ServiceError:
            return False
    else:
        transaction = state.get("install_transaction") or {}
        fallback_path = Path(transaction.get("fallback_plist", ""))
        fallback_arguments = transaction.get("fallback_arguments")
        try:
            validate_plist(fallback_path, state["guard"]["service"], fallback_arguments,
                           transaction.get("original_digest"))
        except (ServiceError, OSError):
            return False
        # ponytail: fallback supports the existing direct Node custom-server form;
        # wrappers need a separately reviewed identity adapter.
        if not isinstance(fallback_arguments, list) or len(fallback_arguments) < 3:
            return False
        expected_node = str(Path(fallback_arguments[0]).resolve())
        expected_script = Path(fallback_arguments[-1]).resolve()
        service_name = state["guard"]["service"]
        job_pid = loaded_job_pid(service_name)
        if job_pid is None or not listeners:
            return False
        try:
            snapshot = process_snapshot(job_pid)
        except ServiceError:
            return False
        if expected_node not in snapshot["texts"] or snapshot["cwd"] != str(expected_script.parent):
            return False
        if not all(pid_descends_from(pid, job_pid) for pid in listeners):
            return False
    return health(int(state["config"]["port"]), min(timeout, 2))


def guard(service_dir: Path) -> None:
    store = StateStore(service_dir / "state.json")
    while True:
        state = store.read()
        guard_config = state["guard"]
        service = guard_config["service"]
        domain = guard_config["domain"]
        transaction = state.get("install_transaction")
        try:
            if transaction and transaction.get("phase") != "committed":
                phase = transaction.get("phase")
                # The guard, not the installer shell, owns the one unavoidable
                # migration bootout/bootstrap transaction and original fallback.
                if phase == "armed":
                    result = launchctl("bootout", service)
                    if result.returncode != 0 and _loaded(service):
                        raise ServiceError(f"migration bootout failed exit={result.returncode}")
                    with store.locked() as locked:
                        locked["install_transaction"]["phase"] = "bootstrapping-stable"
                        locked["phase"] = "installing"
                    phase = "bootstrapping-stable"
                if phase == "bootstrapping-stable":
                    stable_plist = Path(transaction["stable_plist"])
                    validate_plist(stable_plist, service)
                    stable_arguments = plistlib.loads(stable_plist.read_bytes())["ProgramArguments"]
                    if _loaded(service):
                        if not loaded_job_matches(service, stable_arguments):
                            raise ServiceError("Unexpected gateway job loaded during migration")
                        selected = "stable"
                    else:
                        selected = bootstrap_with_fallback(
                            domain, service, stable_plist,
                            Path(transaction["fallback_plist"]) if transaction.get("fallback_plist") else None,
                            int(guard_config.get("bootstrap_attempts", 3)),
                        )
                    with store.locked() as locked:
                        locked["install_transaction"]["loaded"] = selected
                        locked["install_transaction"]["phase"] = "loaded"
                        locked["phase"] = "installing"
                    phase = "loaded"
                if phase == "fallback":
                    if _loaded(service):
                        result = launchctl("bootout", service)
                        if result.returncode != 0 and _loaded(service):
                            raise ServiceError(f"fallback bootout failed exit={result.returncode}")
                    selected = bootstrap_one(
                        domain, service, Path(transaction["fallback_plist"]), "fallback",
                        int(guard_config.get("bootstrap_attempts", 3)),
                        transaction.get("original_digest"), transaction.get("fallback_arguments"),
                    )
                    with store.locked() as locked:
                        locked["install_transaction"]["loaded"] = selected
                        locked["install_transaction"]["phase"] = "loaded"
                        locked["phase"] = "installing"
                    phase = "loaded"
                if phase == "loaded":
                    selected = store.read()["install_transaction"].get("loaded")
                    deadline = time.monotonic() + float(guard_config.get("install_health_timeout", 45))
                    while time.monotonic() < deadline:
                        if prove_install_health(store, selected, 2):
                            break
                        if not _loaded(service):
                            raise ServiceError("gateway job disappeared during installation")
                        time.sleep(1)
                    else:
                        if selected == "stable":
                            with store.locked() as locked:
                                locked["install_transaction"]["phase"] = "fallback"
                                _diagnostic(locked, "Stable gateway unhealthy; restoring original job")
                            continue
                        raise ServiceError("fallback gateway health deadline exceeded")
                    active_key = "stable_plist" if selected == "stable" else "fallback_plist"
                    latest = store.read()
                    active_plist = Path(latest["install_transaction"][active_key])
                    final_plist = Path(latest["install_transaction"]["final_plist"])
                    atomic_write(final_plist, active_plist.read_bytes(), 0o600)
                    with store.locked() as locked:
                        locked["install_transaction"]["phase"] = "committed"
                        locked["guard"]["stable_plist"] = str(final_plist)
                        locked["phase"] = "healthy"
                        _diagnostic(locked, f"Installation transaction committed on {selected}")
            elif not _loaded(service):
                bootstrap_with_fallback(domain, service, Path(guard_config["stable_plist"]),
                                        None, int(guard_config.get("bootstrap_attempts", 3)))
                with store.locked() as locked:
                    _diagnostic(locked, "Guard restored missing gateway job")
            with store.locked() as locked:
                locked["guard_status"] = {"ok": True, "checked_at": _now(), "error": None}
        except ServiceError as error:
            with contextlib.suppress(ServiceError):
                with store.locked() as locked:
                    locked["guard_status"] = {"ok": False, "checked_at": _now(), "error": str(error)[:1000]}
                    _diagnostic(locked, f"Guard recovery failed: {error}")
                    if locked.get("install_transaction") and locked["install_transaction"].get("phase") != "committed":
                        locked["install_transaction"]["phase"] = "fallback"
        time.sleep(float(guard_config.get("interval", 10)))


def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("supervise", "guard"))
    parser.add_argument("--service-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "supervise":
        supervise(args.service_dir.resolve(strict=True))
        return 0
    guard(args.service_dir.resolve(strict=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except ServiceError as error:
        print(f"gateway-service: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
