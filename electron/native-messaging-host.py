import ctypes
import json
import os
import re
import struct
import sys
import time


PIPE_NAME = r"\\.\pipe\folio-browser-bridge-v1"
MAX_MESSAGE_BYTES = 1024 * 1024
EXTENSION_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}/\Z")
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
ERROR_FILE_NOT_FOUND = 2
ERROR_PIPE_BUSY = 231
ERROR_NO_DATA = 232


def read_exact(stream, size, allow_eof=False):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            if allow_eof and not chunks:
                return None
            raise EOFError("unexpected end of message")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream):
    header = read_exact(stream, 4, allow_eof=True)
    if header is None:
        return None
    length = struct.unpack("<I", header)[0]
    if length > MAX_MESSAGE_BYTES:
        raise ValueError("native message exceeds limit")
    return read_exact(stream, length)


def write_all(stream, payload):
    remaining = memoryview(payload)
    while remaining:
        written = stream.write(remaining)
        if not written:
            raise EOFError("pipe closed while writing")
        remaining = remaining[written:]


def write_frame(stream, payload):
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_MESSAGE_BYTES:
        encoded = json.dumps(
            {"ok": False, "error": "本机响应内容过大。"},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    write_all(stream, struct.pack("<I", len(encoded)))
    write_all(stream, encoded)
    stream.flush()


def open_pipe(pipe_name):
    if os.name != "nt":
        raise OSError("Folio 浏览器连接仅支持 Windows。")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    create_file.restype = ctypes.c_void_p
    deadline = time.monotonic() + 2.0
    last_error = ERROR_FILE_NOT_FOUND
    while time.monotonic() < deadline:
        handle = create_file(
            pipe_name,
            GENERIC_READ | GENERIC_WRITE,
            0,
            None,
            OPEN_EXISTING,
            0,
            None,
        )
        if handle != INVALID_HANDLE_VALUE:
            import msvcrt

            descriptor = msvcrt.open_osfhandle(int(handle), os.O_BINARY | os.O_RDWR)
            return os.fdopen(descriptor, "r+b", buffering=0)
        last_error = ctypes.get_last_error()
        if last_error not in (ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_NO_DATA):
            break
        time.sleep(0.1)
    raise OSError(last_error, "Folio 桌面工作台尚未启动。")


def valid_sender():
    return any(EXTENSION_ORIGIN.fullmatch(argument) for argument in sys.argv[1:])


def host_options():
    local_app_data = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    secret_path = os.path.join(local_app_data, "Folio", "browser-bridge.secret")
    pipe_name = PIPE_NAME
    for argument in sys.argv[1:]:
        if argument.startswith("--folio-test-pipe="):
            pipe_name = argument.split("=", 1)[1]
        elif argument.startswith("--folio-test-secret="):
            secret_path = argument.split("=", 1)[1]
    return pipe_name, secret_path


def read_secret(secret_path):
    if os.path.islink(secret_path):
        raise OSError("invalid bridge secret")
    with open(secret_path, "r", encoding="ascii") as secret_file:
        secret = secret_file.read(128).strip()
    if not re.fullmatch(r"[a-f0-9]{64}", secret):
        raise OSError("invalid bridge secret")
    return secret


def connect_pipe(pipe_name, secret):
    pipe = open_pipe(pipe_name)
    try:
        write_frame(pipe, {"id": "native-auth", "type": "FOLIO_NATIVE_AUTH", "secret": secret})
        response_frame = read_frame(pipe)
        response = json.loads(response_frame.decode("utf-8")) if response_frame is not None else {}
        if response.get("id") != "native-auth" or not response.get("ok"):
            raise OSError("Folio bridge authentication failed")
        return pipe
    except Exception:
        pipe.close()
        raise


def main():
    if not valid_sender():
        return 2

    pipe = None
    pipe_name, secret_path = host_options()
    secret = ""
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    try:
        while True:
            frame = read_frame(stdin)
            if frame is None:
                break
            request = {}
            try:
                request = json.loads(frame.decode("utf-8"))
                if not isinstance(request, dict):
                    raise ValueError("request must be an object")
                if pipe is None:
                    if not secret:
                        secret = read_secret(secret_path)
                    pipe = connect_pipe(pipe_name, secret)
                write_all(pipe, struct.pack("<I", len(frame)))
                write_all(pipe, frame)
                pipe.flush()
                response_frame = read_frame(pipe)
                if response_frame is None:
                    raise EOFError("Folio connection closed")
                response = json.loads(response_frame.decode("utf-8"))
                if not isinstance(response, dict):
                    raise ValueError("response must be an object")
            except Exception:
                if pipe is not None:
                    try:
                        pipe.close()
                    except Exception:
                        pass
                    pipe = None
                response = {"ok": False, "error": "无法连接本机 Folio，请确认桌面工作台已打开。"}
            if "id" in request:
                response["id"] = request["id"]
            write_frame(stdout, response)
    except (EOFError, ValueError):
        return 1
    finally:
        if pipe is not None:
            pipe.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
