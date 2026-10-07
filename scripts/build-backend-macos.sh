#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
BUILD_TEMP="$RUNNER_TEMP/folio-backend-build"
PYTHON="$ROOT/.venv-macos/bin/python"
mkdir -p "$BUILD_TEMP" "$RUNNER_TEMP/folio-pip-cache" "$RUNNER_TEMP/folio-pyinstaller-cache" "$ROOT/backend/dist" "$ROOT/backend/build-macos"
export TMPDIR="$BUILD_TEMP"
export PIP_CACHE_DIR="$RUNNER_TEMP/folio-pip-cache"
export PYINSTALLER_CONFIG_DIR="$RUNNER_TEMP/folio-pyinstaller-cache"

if [[ ! -x "$PYTHON" ]]; then
  python3 -m venv "$ROOT/.venv-macos"
fi
"$PYTHON" -m pip install --quiet --disable-pip-version-check -r "$ROOT/backend/requirements.txt"
cd "$ROOT"
"$PYTHON" -m PyInstaller \
  --noconfirm --clean --onefile --name workbench-service \
  --distpath "$ROOT/backend/dist" \
  --workpath "$ROOT/backend/build-macos" \
  --specpath "$ROOT/backend/build-macos" \
  --paths "$ROOT" \
  --collect-submodules keyring.backends \
  --hidden-import keyring.backends.macOS \
  backend/entrypoint.py

test -x "$ROOT/backend/dist/workbench-service"
file "$ROOT/backend/dist/workbench-service"
