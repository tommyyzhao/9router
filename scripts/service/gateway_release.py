#!/usr/bin/env python3
"""Install, stage, promote, and inspect the stable gateway service.

Routine stage/promote commands only validate and atomically record intent.  They
never call launchctl or signal the gateway.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

SOURCE = Path(__file__).with_name("gateway_service.py")
spec = importlib.util.spec_from_file_location("gateway_service", SOURCE)
service = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(service)


class ReleaseError(service.ServiceError):
    pass


def _ensure_content(destination: Path, content: bytes, mode: int) -> None:
    if destination.exists():
        if destination.is_symlink() or not destination.is_file() or destination.read_bytes() != content:
            raise ReleaseError(f"Existing install artifact differs: {destination}")
        return
    service.atomic_write(destination, content, mode)


def _copy_atomic(source: Path, destination: Path, mode: int) -> None:
    if source.is_symlink() or not source.is_file():
        raise ReleaseError(f"Source must be a regular file: {source}")
    _ensure_content(destination, source.read_bytes(), mode)


def _label(value: str) -> str:
    if not value or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_" for character in value):
        raise ReleaseError("Invalid launchd label")
    return value


def _plist(label: str, arguments: list[str], environment: dict[str, str],
           stdout: Path, stderr: Path, throttle: int = 5, keepalive: bool = True) -> bytes:
    payload = {
        "Label": label,
        "ProgramArguments": arguments,
        "EnvironmentVariables": environment,
        "RunAtLoad": True,
        "KeepAlive": keepalive,
        "ThrottleInterval": throttle,
        "ProcessType": "Background",
        "StandardOutPath": str(stdout),
        "StandardErrorPath": str(stderr),
    }
    return plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=True)


def _config(args, service_dir: Path, releases_dir: Path, child_log: Path) -> dict:
    return {
        "port": args.port,
        "hostname": args.hostname,
        "home": str(args.home.resolve()),
        "data_dir": str(args.data_dir.resolve()),
        "releases_dir": str(releases_dir.resolve()),
        "runtime_path": args.runtime_path,
        "child_log": str(child_log.resolve()),
        "startup_timeout": args.startup_timeout,
        "probation": args.probation,
        "health_interval": args.health_interval,
        "health_failures": args.health_failures,
        "failure_budget": args.failure_budget,
        "max_backoff": args.max_backoff,
        "degraded_interval": args.degraded_interval,
    }


def install(args) -> None:
    service_dir = args.service_dir.resolve()
    bin_dir = args.bin_dir.resolve()
    releases_dir = args.releases_dir.resolve(strict=True)
    launch_agents = args.launch_agents.resolve()
    label = _label(args.label)
    guard_label = _label(args.guard_label)
    stable_service = bin_dir / "gateway_service.py"
    stable_release = bin_dir / "gateway_release.py"
    staged_gateway_plist = service_dir / f"{label}.supervisor.plist"
    final_gateway_plist = launch_agents / f"{label}.plist"
    guard_plist = launch_agents / f"{guard_label}.plist"
    state_path = service_dir / "state.json"
    if state_path.exists():
        raise ReleaseError(f"Install state already exists; use status: {state_path}")
    for directory in (service_dir, bin_dir, launch_agents, args.log_dir.resolve()):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(service_dir, 0o700)
    os.chmod(bin_dir, 0o700)
    python = args.python.resolve(strict=True)
    node = args.node.resolve(strict=True)
    if not os.access(python, os.X_OK) or not os.access(node, os.X_OK):
        raise ReleaseError("Pinned Python and Node must be executable")
    env_file = args.env_file.resolve(strict=True)
    schema_digest = args.schema_digest or service.fingerprint_schema(args.schema_source)
    baseline = service.validate_release(args.baseline, releases_dir, node, env_file, schema_digest)
    domain = f"gui/{os.getuid()}"
    gateway_plist = staged_gateway_plist
    child_log = args.log_dir.resolve() / "gateway-child.log"
    runtime_environment = {"HOME": str(args.home.resolve()), "PATH": args.runtime_path}
    gateway_content = _plist(
        label, [str(python), str(stable_service), "supervise", "--service-dir", str(service_dir)],
        runtime_environment,
        args.log_dir.resolve() / "supervisor.log", args.log_dir.resolve() / "supervisor.err",
    )
    guard_content = _plist(
        guard_label, [str(python), str(stable_service), "guard", "--service-dir", str(service_dir)],
        runtime_environment,
        args.log_dir.resolve() / "guard.log", args.log_dir.resolve() / "guard.err",
    )
    state = {
        "phase": "installed-unarmed",
        "current": args.baseline.name,
        "qualified": args.baseline.name,
        "last_good": args.baseline.name,
        "releases": {args.baseline.name: baseline},
        "transition": None,
        "child": None,
        "failures": [],
        "rollback_attempted": None,
        "diagnostic": "Installed; guard migration not armed",
        "diagnostic_at": time.time(),
        "config": _config(args, service_dir, releases_dir, child_log),
        "guard": {
            "label": guard_label, "service": f"{domain}/{label}", "domain": domain,
            "stable_plist": str(gateway_plist), "final_plist": str(final_gateway_plist),
            "interval": args.guard_interval,
            "bootstrap_attempts": args.bootstrap_attempts,
            "install_health_timeout": args.startup_timeout,
        },
        "guard_status": None,
        "install_transaction": None,
    }
    # Artifacts are content-idempotent; state is the final prepare commit. A crash
    # before it can safely rerun, while mismatched leftovers fail closed.
    _copy_atomic(SOURCE, stable_service, 0o700)
    _copy_atomic(Path(__file__), stable_release, 0o700)
    _ensure_content(gateway_plist, gateway_content, 0o600)
    _ensure_content(guard_plist, guard_content, 0o600)
    store = service.StateStore(state_path)
    store.create(state)
    print(json.dumps({"state": str(store.path), "gateway_plist": str(gateway_plist),
                      "guard_plist": str(guard_plist), "baseline": args.baseline.name}, indent=2))


def arm_install(args) -> None:
    store = service.StateStore(args.service_dir.resolve(strict=True) / "state.json")
    state = store.read()
    if state.get("install_transaction"):
        raise ReleaseError("Installation transaction already exists")
    stable = Path(state["guard"]["stable_plist"]).resolve(strict=True)
    fallback_source = args.original_plist.resolve(strict=True)
    fallback_copy = args.service_dir.resolve() / "original-gateway.plist"
    _copy_atomic(fallback_source, fallback_copy, 0o600)
    fallback_payload = plistlib.loads(fallback_copy.read_bytes())
    fallback_arguments = fallback_payload.get("ProgramArguments")
    if fallback_payload.get("Label") != state["guard"]["service"].rsplit("/", 1)[-1] or not isinstance(fallback_arguments, list):
        raise ReleaseError("Original plist Label/ProgramArguments do not match guarded job")
    with store.locked() as locked:
        locked["install_transaction"] = {
            "phase": "armed", "stable_plist": str(stable),
            "fallback_plist": str(fallback_copy),
            "fallback_arguments": fallback_arguments,
            "final_plist": state["guard"]["final_plist"],
            "original_digest": hashlib.sha256(fallback_copy.read_bytes()).hexdigest(),
            "armed_at": time.time(),
        }
        locked["phase"] = "install-armed"
    print("Installation transaction armed. Bootstrap the guard plist; the guard owns migration and fallback.")


def _free_loopback_port() -> int:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    finally:
        sock.close()
    if port in {20128, 20129, 20130, 8787}:
        return _free_loopback_port()
    return port


def validate_candidate_runtime(release: dict, scratch_root: Path, timeout: float,
                               runtime_path: str) -> None:
    port = _free_loopback_port()
    scratch_home = scratch_root / "home"
    scratch_data = scratch_root / "data"
    scratch_home.mkdir(parents=True, mode=0o700)
    scratch_data.mkdir(parents=True, mode=0o700)
    log_path = scratch_root / "candidate.log"
    read_fd, write_fd = os.pipe()
    process = service.spawn_child(
        release, port, "127.0.0.1", scratch_data, scratch_home, log_path,
        (read_fd, write_fd), {"PATH": runtime_path, "DISABLE_BACKGROUND_TOKEN_REFRESH": "1",
                              "MODEL_CATALOG_SYNC": "off"},
    )
    os.close(read_fd)
    record = None
    try:
        record = service.capture_child_identity(process.pid, release, port)
        os.write(write_fd, b"1")
        if not service.wait_ready(record, timeout):
            raise ReleaseError(f"Candidate readiness/identity deadline exceeded; inspect {log_path}")
    finally:
        os.close(write_fd)
        if record is not None:
            try:
                service.stop_child(record)
            except service.ServiceError:
                if process.poll() is None:
                    raise
        elif process.poll() is None:
            os.killpg(process.pid, 9)
            process.wait(timeout=5)
        if service.listener_pids(port):
            raise ReleaseError("Candidate left a scratch listener behind")


def stage(args) -> None:
    store = service.StateStore(args.service_dir.resolve(strict=True) / "state.json")
    state = store.read()
    if state.get("transition"):
        raise ReleaseError("A transition is already pending")
    config = state["config"]
    baseline = state["releases"][state["qualified"]]
    schema_digest = service.fingerprint_schema(args.schema_source)
    if schema_digest != baseline["schema_digest"]:
        raise ReleaseError("Database schema digest differs from qualified release; explicit compatibility review required")
    release = service.validate_release(args.release, Path(config["releases_dir"]),
                                       Path(baseline["node"]), Path(baseline["env_file"]), schema_digest)
    with tempfile.TemporaryDirectory(prefix="9router-stage-") as raw:
        validate_candidate_runtime(release, Path(raw), args.timeout, config["runtime_path"])
    # Rehash after running; a mutable candidate cannot become staged.
    checked = service.validate_release(args.release, Path(config["releases_dir"]), Path(baseline["node"]),
                                       Path(baseline["env_file"]), schema_digest)
    if checked != release:
        raise ReleaseError("Validated release or stable environment changed")
    with store.locked() as locked:
        if locked.get("transition"):
            raise ReleaseError("A transition appeared while staging")
        locked["releases"][args.release.name] = release
        locked["phase"] = "staged"
        locked["diagnostic"] = f"Staged: {args.release.name}"
        locked["diagnostic_at"] = time.time()
    print(json.dumps(release, indent=2))


def promote(args) -> None:
    store = service.StateStore(args.service_dir.resolve(strict=True) / "state.json")
    snapshot = store.read()
    if snapshot.get("transition"):
        raise ReleaseError("A transition is already pending")
    if args.release_name not in snapshot.get("releases", {}):
        raise ReleaseError("Release is not staged")
    target = snapshot["releases"][args.release_name]
    baseline = snapshot["releases"][snapshot["qualified"]]
    service.validate_release(Path(target["path"]), Path(snapshot["config"]["releases_dir"]),
                             Path(target["node"]), Path(target["env_file"]),
                             target["schema_digest"], target)
    if target["schema_digest"] != baseline["schema_digest"]:
        raise ReleaseError("Database compatibility gate blocked promotion")
    with store.locked() as state:
        if state["generation"] != snapshot["generation"] or state.get("transition"):
            raise ReleaseError("State changed during validation; retry promotion")
        if state.get("child") is None or state.get("phase") not in {"healthy", "staged"}:
            raise ReleaseError("Current supervised gateway is not healthy")
        state["transition"] = {
            "id": f"{int(time.time())}-{args.release_name}", "phase": "queued",
            "target": args.release_name, "rollback": state["qualified"],
            "queued_at": time.time(),
        }
        state["phase"] = "transition-queued"
    print(f"Queued {args.release_name}; supervisor owns stop/start/rollback.")


def status(args) -> None:
    state = service.StateStore(args.service_dir.resolve(strict=True) / "state.json").read()
    redacted = dict(state)
    if "config" in redacted:
        redacted["config"] = dict(redacted["config"])
    print(json.dumps(redacted, indent=2, sort_keys=True))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install")
    install_parser.set_defaults(function=install)
    install_parser.add_argument("--baseline", type=Path, required=True)
    install_parser.add_argument("--python", type=Path, required=True)
    install_parser.add_argument("--node", type=Path, required=True)
    install_parser.add_argument("--env-file", type=Path, required=True)
    install_parser.add_argument("--schema-source", type=Path, required=True,
                                help="versioned source tree containing src/lib/db/migrations")
    install_parser.add_argument("--schema-digest",
                                help="reviewed schema digest override for packaged releases")
    install_parser.add_argument("--service-dir", type=Path, required=True)
    install_parser.add_argument("--bin-dir", type=Path, required=True)
    install_parser.add_argument("--releases-dir", type=Path, required=True)
    install_parser.add_argument("--launch-agents", type=Path, required=True)
    install_parser.add_argument("--log-dir", type=Path, required=True)
    install_parser.add_argument("--home", type=Path, required=True)
    install_parser.add_argument("--data-dir", type=Path, required=True)
    install_parser.add_argument("--label", default="io.9router.gateway")
    install_parser.add_argument("--guard-label", default="io.9router.gateway.guard")
    install_parser.add_argument("--port", type=int, default=20128)
    install_parser.add_argument("--hostname", default="0.0.0.0")
    install_parser.add_argument("--runtime-path", required=True,
                                help="approved original gateway PATH; contents are never logged")
    install_parser.add_argument("--startup-timeout", type=float, default=45)
    install_parser.add_argument("--probation", type=float, default=120)
    install_parser.add_argument("--health-interval", type=float, default=5)
    install_parser.add_argument("--health-failures", type=int, default=3)
    install_parser.add_argument("--failure-budget", type=int, default=3)
    install_parser.add_argument("--max-backoff", type=float, default=30)
    install_parser.add_argument("--degraded-interval", type=float, default=30)
    install_parser.add_argument("--guard-interval", type=float, default=10)
    install_parser.add_argument("--bootstrap-attempts", type=int, default=3)

    arm = commands.add_parser("arm-install")
    arm.set_defaults(function=arm_install)
    arm.add_argument("--service-dir", type=Path, required=True)
    arm.add_argument("--original-plist", type=Path, required=True)

    stage_parser = commands.add_parser("stage")
    stage_parser.set_defaults(function=stage)
    stage_parser.add_argument("--service-dir", type=Path, required=True)
    stage_parser.add_argument("--release", type=Path, required=True)
    stage_parser.add_argument("--schema-source", type=Path, required=True)
    stage_parser.add_argument("--timeout", type=float, default=45)

    promote_parser = commands.add_parser("promote")
    promote_parser.set_defaults(function=promote)
    promote_parser.add_argument("--service-dir", type=Path, required=True)
    promote_parser.add_argument("--release-name", required=True)

    status_parser = commands.add_parser("status")
    status_parser.set_defaults(function=status)
    status_parser.add_argument("--service-dir", type=Path, required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    args.function(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReleaseError, service.ServiceError, OSError, ValueError) as error:
        print(f"gateway-release: {error}", file=sys.stderr)
        raise SystemExit(1)
