#!/usr/bin/env python3
"""Measure interactive readiness and memory for a command attached to a PTY."""

from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time
from pathlib import Path
from typing import BinaryIO


ANSI_ESCAPE = re.compile(rb"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
TIMING_HEADER = re.compile(r"^--- Startup Timings: (main|extensions) ---$")
TIMING_EXTENSION_ENTRY = re.compile(
    r"^(?:/[^:\r\n]+|<inline:[^>\r\n]+>) (?:module import|factory): \d+ms$"
)
TIMING_SEPARATOR = re.compile(r"^-{3,}$")
MAIN_TIMING_LABELS = {
    "parseArgs",
    "runMigrations",
    "createSessionManager",
    "createRuntime",
    "createAgentSessionRuntime",
    "readPipedStdin",
    "prepareInitialMessage",
    "initTheme",
    "resolveModelScope",
    "createAgentSession",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure a command's PTY readiness and process-tree memory."
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        metavar="SECONDS",
        help="overall process timeout (default: 10)",
    )
    parser.add_argument(
        "--hold",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="keep the process alive after readiness before sending /quit",
    )
    parser.add_argument(
        "--sample-interval",
        type=float,
        default=0.05,
        metavar="SECONDS",
        help="RSS sampling interval (default: 0.05)",
    )
    parser.add_argument(
        "--vmmap",
        action="store_true",
        help="on macOS, capture vmmap's Physical footprint after readiness",
    )
    parser.add_argument(
        "--timing-file",
        type=Path,
        metavar="PATH",
        help="write only structured Pi startup timing groups to PATH",
    )
    offline = parser.add_mutually_exclusive_group()
    offline.add_argument(
        "--offline",
        dest="offline",
        action="store_true",
        help="set PI_OFFLINE=1 (the default)",
    )
    offline.add_argument(
        "--online",
        dest="offline",
        action="store_false",
        help="run with PI_OFFLINE=0",
    )
    parser.set_defaults(offline=True)
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="command and arguments; put -- before the command",
    )
    args = parser.parse_args()
    if not args.command:
        parser.error("a command is required (for example: -- pi --no-session)")
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    if args.hold < 0:
        parser.error("--hold must not be negative")
    if args.sample_interval <= 0:
        parser.error("--sample-interval must be greater than zero")
    if args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("a command is required")
    return args


def child_environment(offline: bool) -> dict[str, str]:
    environment = os.environ.copy()
    environment["PI_OFFLINE"] = "1" if offline else "0"
    for name in list(environment):
        if name.startswith("HERDR_") or name.startswith("MOSHI_"):
            del environment[name]
    return environment


def terminal_is_raw(slave_fd: int) -> bool:
    try:
        attributes = termios.tcgetattr(slave_fd)
    except OSError:
        return False
    return not bool(attributes[3] & termios.ICANON)


def process_tree_rss(root_pid: int) -> tuple[int, int, int]:
    """Return root RSS, tree RSS, and process count, all RSS values in KiB."""
    try:
        completed = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,rss="],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1.0,
            env={"PATH": os.environ.get("PATH", "")},
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0, 0, 0

    processes: dict[int, tuple[int, int]] = {}
    for line in completed.stdout.splitlines():
        fields = line.split()
        if len(fields) < 3:
            continue
        try:
            pid, ppid, rss = (int(fields[0]), int(fields[1]), int(fields[2]))
        except ValueError:
            continue
        processes[pid] = (ppid, rss)

    tree = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _rss) in processes.items():
            if pid not in tree and ppid in tree:
                tree.add(pid)
                changed = True

    root_rss = processes.get(root_pid, (0, 0))[1]
    tree_rss = sum(processes[pid][1] for pid in tree if pid in processes)
    process_count = sum(1 for pid in tree if pid in processes)
    return root_rss, tree_rss, process_count


def parse_vmmap_footprint(output: str) -> int | None:
    match = re.search(
        r"^\s*Physical footprint:\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?)B?\s*$",
        output,
        re.IGNORECASE | re.MULTILINE,
    )
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2).upper()
    multipliers = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "P": 1024**5}
    return int(value * multipliers[unit] / 1024)


def capture_vmmap_footprint(pid: int, timeout: float) -> int | None:
    if sys.platform != "darwin" or timeout <= 0:
        return None
    try:
        completed = subprocess.run(
            ["vmmap", "-summary", str(pid)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return parse_vmmap_footprint(completed.stdout)


def kill_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        return

    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except (OSError, ProcessLookupError):
            break
        time.sleep(0.02)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass

    if process.poll() is None:
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass


def write_timing_lines(
    handle: BinaryIO | None,
    pending: bytearray,
    data: bytes,
    timing_group: str | None,
) -> str | None:
    if handle is None:
        return timing_group
    pending.extend(ANSI_ESCAPE.sub(b"", data))
    while b"\n" in pending:
        raw_line, _, remainder = pending.partition(b"\n")
        pending[:] = remainder
        line = raw_line.decode("utf-8", errors="replace").strip()
        header_match = TIMING_HEADER.fullmatch(line)
        if header_match:
            timing_group = header_match.group(1)
            handle.write((line + "\n").encode("utf-8"))
        elif timing_group and line.startswith("TOTAL: ") and re.fullmatch(
            r"\d+ms", line.removeprefix("TOTAL: ")
        ):
            handle.write((line + "\n").encode("utf-8"))
        elif timing_group == "main" and ": " in line:
            label, value = line.rsplit(": ", 1)
            if label not in MAIN_TIMING_LABELS or not re.fullmatch(r"\d+ms", value):
                continue
            handle.write((line + "\n").encode("utf-8"))
        elif timing_group == "extensions" and TIMING_EXTENSION_ENTRY.fullmatch(line):
            handle.write((line + "\n").encode("utf-8"))
        elif timing_group and TIMING_SEPARATOR.fullmatch(line):
            handle.write((line + "\n").encode("utf-8"))
            timing_group = None
        else:
            continue
        handle.flush()
    return timing_group


def run(args: argparse.Namespace) -> tuple[dict[str, object], int]:
    master_fd, slave_fd = pty.openpty()
    timing_handle: BinaryIO | None = None
    timing_pending = bytearray()
    timing_group: str | None = None
    process: subprocess.Popen[bytes] | None = None
    started = time.monotonic()
    ready_at: float | None = None
    quit_sent = False
    timed_out = False
    max_root_rss = 0
    max_tree_rss = 0
    max_process_count = 0
    physical_footprint_kb: int | None = None

    if args.timing_file is not None:
        args.timing_file.parent.mkdir(parents=True, exist_ok=True)
        timing_handle = args.timing_file.open("wb")

    try:
        process = subprocess.Popen(
            args.command,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=child_environment(args.offline),
            start_new_session=True,
            close_fds=True,
        )
        deadline = started + args.timeout
        next_sample = started
        hold_until: float | None = None

        while True:
            now = time.monotonic()
            if process.poll() is not None:
                break
            if now >= deadline:
                timed_out = True
                kill_process_group(process)
                break

            if now >= next_sample:
                root_rss, tree_rss, process_count = process_tree_rss(process.pid)
                max_root_rss = max(max_root_rss, root_rss)
                max_tree_rss = max(max_tree_rss, tree_rss)
                max_process_count = max(max_process_count, process_count)
                next_sample = now + args.sample_interval

            if ready_at is None and terminal_is_raw(slave_fd):
                ready_at = now
                hold_until = now + args.hold

            if ready_at is not None and not quit_sent:
                if hold_until is not None and now >= hold_until:
                    if args.vmmap:
                        physical_footprint_kb = capture_vmmap_footprint(
                            process.pid, max(0.0, deadline - now)
                        )
                    try:
                        # Pi's raw key handler uses carriage return for Enter.
                        os.write(master_fd, b"/quit\r")
                    except OSError:
                        pass
                    quit_sent = True

            wait_for = min(
                args.sample_interval,
                max(0.0, deadline - now),
            )
            if ready_at is not None and not quit_sent and hold_until is not None:
                wait_for = min(wait_for, max(0.0, hold_until - now))
            if wait_for <= 0:
                continue
            try:
                readable, _, _ = select.select([master_fd], [], [], wait_for)
            except (OSError, ValueError):
                readable = []
            if readable:
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    timing_group = write_timing_lines(
                        timing_handle, timing_pending, data, timing_group
                    )
        if process.poll() is None:
            process.wait(timeout=0.5)
        # Drain only to make sure the PTY cannot retain a child write; never print it.
        while True:
            try:
                readable, _, _ = select.select([master_fd], [], [], 0)
            except (OSError, ValueError):
                break
            if not readable:
                break
            try:
                data = os.read(master_fd, 65536)
            except OSError:
                break
            if not data:
                break
            timing_group = write_timing_lines(
                timing_handle, timing_pending, data, timing_group
            )
    except OSError as error:
        result = {
            "exit_status": None,
            "ready_ms": None,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            "root_rss_kb": max_root_rss,
            "process_tree_rss_kb": max_tree_rss,
            "max_process_count": max_process_count,
            "timed_out": False,
            "physical_footprint_kb": physical_footprint_kb,
            "error": str(error),
        }
        return result, 1
    finally:
        if timing_pending:
            write_timing_lines(timing_handle, timing_pending, b"\n", timing_group)
        if process is not None:
            kill_process_group(process)
        if timing_handle is not None:
            timing_handle.close()
        for fd in (master_fd, slave_fd):
            try:
                os.close(fd)
            except OSError:
                pass

    result = {
        "exit_status": process.returncode if process is not None else None,
        "ready_ms": round((ready_at - started) * 1000, 3) if ready_at is not None else None,
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        "root_rss_kb": max_root_rss,
        "process_tree_rss_kb": max_tree_rss,
        "max_process_count": max_process_count,
        "timed_out": timed_out,
        "physical_footprint_kb": physical_footprint_kb,
    }
    return result, 0


def main() -> int:
    args = parse_args()
    result, status = run(args)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return status


if __name__ == "__main__":
    sys.exit(main())
