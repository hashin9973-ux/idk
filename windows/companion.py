#!/usr/bin/env python3
"""Constrained Chrome/Edge Native Messaging host for the Windows Bridge prototype."""
from __future__ import annotations
import itertools, json, os, shutil, signal, struct, subprocess, sys, threading, time, uuid
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_FILE_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
MAX_LIST_ENTRIES = 500
TEST_TIMEOUT_SECONDS = 120
HOST_NAME = "com.chatgpt.windowsbridge"

class BridgeError(Exception):
    """Expected validation or operation failure suitable for display."""

def _config_path() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        raise BridgeError("LOCALAPPDATA is not set; run the Windows installer first")
    return Path(base) / "ChatGPTWindowsBridge" / "config.json"

def load_workspace() -> Path:
    try:
        cfg = json.loads(_config_path().read_text(encoding="utf-8-sig"))
        raw = cfg["workspace_root"]
    except FileNotFoundError as exc:
        raise BridgeError("Configuration not found; run windows/install.ps1") from exc
    except (KeyError, ValueError, OSError) as exc:
        raise BridgeError("Configuration is missing or invalid") from exc
    if not isinstance(raw, str) or not raw.strip():
        raise BridgeError("Configured workspace_root is invalid")
    root = Path(raw).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise BridgeError("Configured workspace directory does not exist")
    return root

def _relative_path(root: Path, raw: Any, *, allow_dot: bool = True) -> Path:
    if not isinstance(raw, str) or not raw or len(raw) > 1024:
        raise BridgeError("path must be a non-empty relative path of at most 1024 characters")
    p = Path(raw)
    if p.is_absolute() or raw.startswith(("\\\\", "//")):
        raise BridgeError("absolute paths are not allowed")
    if any(part == ".." for part in p.parts):
        raise BridgeError("parent traversal is not allowed")
    if not allow_dot and raw == ".":
        raise BridgeError("a file path is required")
    target = (root / p).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise BridgeError("path resolves outside the configured workspace") from exc
    return target

def _strict_keys(task: dict[str, Any], allowed: set[str]) -> None:
    extra = sorted(set(task) - allowed)
    if extra:
        raise BridgeError("unknown request field(s): " + ", ".join(extra))

def _approved(task: dict[str, Any]) -> None:
    if task.get("approved") is not True:
        raise BridgeError("operation requires explicit user approval in the extension")

def _truncate(raw: str, limit: int = MAX_OUTPUT_BYTES) -> str:
    encoded = raw.encode("utf-8", errors="replace")
    if len(encoded) <= limit:
        return raw
    marker = "\n...[output truncated by ChatGPT Windows Bridge]..."
    return encoded[:max(0, limit - len(marker.encode("utf-8")))].decode("utf-8", errors="ignore") + marker

def _list_files(root: Path, task: dict[str, Any]) -> dict[str, Any]:
    _strict_keys(task, {"version", "id", "op", "approved", "path"})
    _approved(task)
    folder = _relative_path(root, task.get("path", "."))
    if not folder.exists() or not folder.is_dir():
        raise BridgeError("directory does not exist")
    rows = []
    try:
        scanned = list(itertools.islice(folder.iterdir(), MAX_LIST_ENTRIES + 1))
        truncated = len(scanned) > MAX_LIST_ENTRIES
        for entry in sorted(scanned[:MAX_LIST_ENTRIES], key=lambda p: p.name.casefold()):
            try:
                resolved = entry.resolve()
                resolved.relative_to(root)
            except (ValueError, OSError):
                continue
            rows.append({"name": entry.name, "kind": "directory" if resolved.is_dir() else "file"})
    except OSError as exc:
        raise BridgeError("cannot list directory") from exc
    return {"path": folder.relative_to(root).as_posix() or ".", "entries": rows,
            "limit": MAX_LIST_ENTRIES, "truncated": truncated}

def _read_file(root: Path, task: dict[str, Any]) -> dict[str, Any]:
    _strict_keys(task, {"version", "id", "op", "approved", "path"})
    _approved(task)
    target = _relative_path(root, task.get("path"), allow_dot=False)
    if not target.exists() or not target.is_file():
        raise BridgeError("file does not exist")
    try:
        if target.stat().st_size > MAX_FILE_BYTES:
            raise BridgeError("file exceeds 256 KiB")
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise BridgeError("only UTF-8 text files can be read") from exc
    except OSError as exc:
        raise BridgeError("cannot read file") from exc
    return {"path": target.relative_to(root).as_posix(), "content": content, "bytes": len(content.encode("utf-8"))}

def _write_file(root: Path, task: dict[str, Any]) -> dict[str, Any]:
    _strict_keys(task, {"version", "id", "op", "approved", "path", "content"})
    _approved(task)
    target = _relative_path(root, task.get("path"), allow_dot=False)
    content = task.get("content")
    if not isinstance(content, str):
        raise BridgeError("content must be a string")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_FILE_BYTES:
        raise BridgeError("content exceeds 256 KiB")
    if not target.parent.exists() or not target.parent.is_dir():
        raise BridgeError("parent directory must already exist")
    if target.exists() and not target.is_file():
        raise BridgeError("target exists and is not a regular file")
    temp = target.with_name("." + target.name + ".redbridge-" + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    except OSError as exc:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        raise BridgeError("cannot write file") from exc
    return {"path": target.relative_to(root).as_posix(), "bytes_written": len(encoded)}

def _capture(pipe: Any, sink: list[bytes], cap: int) -> None:
    kept = 0
    while True:
        chunk = pipe.read(8192)
        if not chunk:
            return
        if kept < cap:
            piece = chunk[:cap - kept]
            sink.append(piece)
            kept += len(piece)

def _run_command(command: list[str], cwd: Path, timeout_seconds: int) -> dict[str, Any]:
    kwargs = {
        "cwd": str(cwd), "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE, "shell": False, "text": False,
        "creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    }
    if os.name != "nt":
        kwargs["start_new_session"] = True
    try:
        proc = subprocess.Popen(command, **kwargs)
    except OSError as exc:
        raise BridgeError("could not start the requested process; check executable and permissions") from exc
    out, err = [], []
    t1 = threading.Thread(target=_capture, args=(proc.stdout, out, MAX_OUTPUT_BYTES + 1), daemon=True)
    t2 = threading.Thread(target=_capture, args=(proc.stderr, err, MAX_OUTPUT_BYTES + 1), daemon=True)
    t1.start()
    t2.start()
    timed_out = False
    try:
        exit_code = proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    shell=False, timeout=5, check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
        if proc.poll() is None:
            proc.kill()
        try:
            exit_code = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            exit_code = proc.wait()
    t1.join(timeout=5)
    t2.join(timeout=5)
    out_text = b"".join(out).decode("utf-8", errors="replace")
    err_text = b"".join(err).decode("utf-8", errors="replace")
    return {
        "exit_code": exit_code,
        "timed_out": timed_out,
        "timeout_seconds": timeout_seconds,
        "stdout": _truncate(out_text),
        "stderr": _truncate(err_text),
        "command": command,
    }

def _run_pytest(root: Path, task: dict[str, Any]) -> dict[str, Any]:
    _strict_keys(task, {"version", "id", "op", "approved", "test_path"})
    _approved(task)
    test_path = task.get("test_path", ".")
    relative = _relative_path(root, test_path)
    if not relative.exists() or not (relative.is_file() or relative.is_dir()):
        raise BridgeError("test_path must identify an existing file or directory")
    command = [sys.executable, "-m", "pytest", "-q"]
    if relative != root:
        command.append(str(relative.relative_to(root)))
    result = _run_command(command, root, TEST_TIMEOUT_SECONDS)
    result["command"] = ["python", "-m", "pytest", "-q"] + ([test_path] if relative != root else [])
    return result

def _run_process(root: Path, task: dict[str, Any]) -> dict[str, Any]:
    _strict_keys(task, {"version", "id", "op", "approved", "executable", "args", "cwd", "timeout_seconds"})
    _approved(task)
    executable = task.get("executable")
    if not isinstance(executable, str) or not executable.strip() or len(executable) > 2048 or "\\x00" in executable:
        raise BridgeError("executable must be a non-empty path or program name")
    args = task.get("args", [])
    if not isinstance(args, list) or len(args) > 128 or any(not isinstance(arg, str) or "\\x00" in arg or len(arg) > 8192 for arg in args):
        raise BridgeError("args must be an array of at most 128 strings; each string is limited to 8192 characters")
    total_arg_bytes = len(executable.encode("utf-8")) + sum(len(arg.encode("utf-8")) for arg in args)
    if total_arg_bytes > 65536:
        raise BridgeError("combined executable and arguments exceed 64 KiB")
    timeout = task.get("timeout_seconds", TEST_TIMEOUT_SECONDS)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= TEST_TIMEOUT_SECONDS:
        raise BridgeError("timeout_seconds must be an integer between 1 and 120")
    cwd_raw = task.get("cwd", ".")
    cwd = _relative_path(root, cwd_raw)
    if not cwd.exists() or not cwd.is_dir():
        raise BridgeError("cwd must be an existing directory inside the configured workspace")

    candidate = Path(executable).expanduser()
    if candidate.is_absolute():
        resolved_executable = candidate.resolve()
        if not resolved_executable.is_file():
            raise BridgeError("executable path does not identify a file")
        program = str(resolved_executable)
    elif "/" in executable or "\\\\" in executable:
        resolved_executable = _relative_path(root, executable, allow_dot=False)
        if not resolved_executable.is_file():
            raise BridgeError("relative executable path does not identify a file in the workspace")
        program = str(resolved_executable)
    else:
        found = shutil.which(executable)
        if not found:
            raise BridgeError("executable was not found on PATH; use an absolute path if appropriate")
        program = str(Path(found).resolve())

    command = [program, *args]
    result = _run_command(command, cwd, timeout)
    result["cwd"] = cwd.relative_to(root).as_posix() or "."
    return result

def execute(task: Any) -> dict[str, Any]:
    start = time.monotonic()
    task_id, operation = str(uuid.uuid4()), "unknown"
    try:
        if not isinstance(task, dict):
            raise BridgeError("request must be a JSON object")
        version = task.get("version")
        if isinstance(version, bool) or version != PROTOCOL_VERSION:
            raise BridgeError("unsupported protocol version; expected 1")
        if task.get("id") is not None:
            if not isinstance(task["id"], str) or not task["id"] or len(task["id"]) > 80:
                raise BridgeError("id must be a string of 1 to 80 characters")
            task_id = task["id"]
        operation = task.get("op", "unknown")
        if not isinstance(operation, str):
            raise BridgeError("op must be a string")
        if operation == "health":
            _strict_keys(task, {"version", "id", "op"})
            data = {"host": HOST_NAME, "status": "ready"}
        else:
            handlers = {"list_files": _list_files, "read_file": _read_file,
                        "write_file": _write_file, "run_pytest": _run_pytest, "run_process": _run_process}
            handler = handlers.get(operation)
            if handler is None:
                raise BridgeError("unsupported operation")
            root = load_workspace()
            data = handler(root, task)
        return {"version": 1, "id": task_id, "op": operation, "ok": True,
                "duration_ms": int((time.monotonic() - start) * 1000), "data": data}
    except BridgeError as exc:
        return {"version": 1, "id": task_id, "op": operation, "ok": False,
                "duration_ms": int((time.monotonic() - start) * 1000), "error": str(exc)}
    except Exception:
        return {"version": 1, "id": task_id, "op": operation, "ok": False,
                "duration_ms": int((time.monotonic() - start) * 1000),
                "error": "internal companion error; check local setup and request"}

def _read_exact(stream: Any, count: int) -> bytes:
    parts, remaining = [], count
    while remaining:
        part = stream.read(remaining)
        if not part:
            if not parts:
                return b""
            raise EOFError("incomplete Native Messaging frame")
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)

def main() -> int:
    source, sink = sys.stdin.buffer, sys.stdout.buffer
    while True:
        header = _read_exact(source, 4)
        if not header:
            return 0
        try:
            size, = struct.unpack("<I", header)
            if size <= 0 or size > MAX_MESSAGE_BYTES:
                response = {"version": 1, "id": "", "op": "unknown", "ok": False,
                            "duration_ms": 0, "error": "invalid Native Messaging request size"}
            else:
                payload = _read_exact(source, size)
                try:
                    response = execute(json.loads(payload.decode("utf-8")))
                except (UnicodeDecodeError, json.JSONDecodeError, EOFError, struct.error):
                    response = {"version": 1, "id": "", "op": "unknown", "ok": False,
                                "duration_ms": 0, "error": "malformed Native Messaging request"}
        except (EOFError, struct.error):
            return 1
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            sink.write(struct.pack("<I", len(encoded))); sink.write(encoded); sink.flush()
        except (OSError, BrokenPipeError):
            return 1

if __name__ == "__main__":
    raise SystemExit(main())
