"""Build an isolated environment for the independently frozen PDF engine."""
from __future__ import annotations

import os
from pathlib import Path
import sys


def pdf_engine_environment(*, entry: str = "") -> dict[str, str]:
    """Copy the parent environment without leaking its bundle library paths.

    Source/entry mode uses a normal Python interpreter and is left unchanged.
    PyInstaller 6.16 resets its own private _PYI_* state when the public reset
    flag is set; do not manually modify those bootloader-owned variables.
    """
    environment = os.environ.copy()
    if not getattr(sys, "frozen", False) or entry:
        return environment

    environment["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    bundle = getattr(sys, "_MEIPASS", None)
    if not bundle:
        return environment
    bundle = Path(bundle).resolve()

    def from_parent_bundle(value: str) -> bool:
        # Empty/relative search entries have user-defined semantics; keep them.
        path = Path(value)
        if not path.is_absolute():
            return False
        try:
            return path.resolve().is_relative_to(bundle)
        except (OSError, RuntimeError, ValueError):
            return False

    # Hooks can add these paths even on macOS, whose bootloader does not.
    # Preserve external entries (and their order), rather than clearing a
    # user library configuration or restoring an unrelated *_ORIG snapshot.
    for name in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"):
        if name not in environment:
            continue
        paths = environment[name].split(os.pathsep)
        kept = [value for value in paths if not from_parent_bundle(value)]
        if kept:
            environment[name] = os.pathsep.join(kept)
        else:
            environment.pop(name)

    # Never guess CA provenance from its path. SSL_CERT_FILE/SSL_CERT_DIR,
    # REQUESTS_CA_BUNDLE and CURL_CA_BUNDLE can be explicit user trust policy;
    # this application does not inject them, so all are intentionally kept.
    return environment
