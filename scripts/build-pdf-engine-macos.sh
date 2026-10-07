#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
BUILD_TEMP="$RUNNER_TEMP/folio-pdf-engine-build"
PYTHON="$ROOT/.venv-pdf-engine-macos/bin/python"
mkdir -p "$BUILD_TEMP" "$RUNNER_TEMP/folio-pdf-engine-pip-cache" "$RUNNER_TEMP/folio-pdf-engine-pyinstaller-cache" "$RUNNER_TEMP/folio-pdf-engine-home" "$ROOT/backend/dist" "$ROOT/backend/build-pdf-engine-macos"
export TMPDIR="$BUILD_TEMP"
export PIP_CACHE_DIR="$RUNNER_TEMP/folio-pdf-engine-pip-cache"
export PYINSTALLER_CONFIG_DIR="$RUNNER_TEMP/folio-pdf-engine-pyinstaller-cache"
export WORKBENCH_PDF_ENGINE_BUILD_HOME="$RUNNER_TEMP/folio-pdf-engine-home"

if [[ ! -x "$PYTHON" ]]; then
  python3 -m venv "$ROOT/.venv-pdf-engine-macos"
fi
"$PYTHON" -m pip install --quiet --disable-pip-version-check 'pdf2zh-next==2.9.0' 'babeldoc==0.6.2' 'pyinstaller==6.16.0'

SITE_PACKAGES="$("$PYTHON" -c 'import site; print(site.getsitepackages()[0])')"
SOURCE_ROOT="$ROOT/backend/pdf-engine-source"
mkdir -p "$SOURCE_ROOT/pdf2zh_next" "$SOURCE_ROOT/babeldoc"
cp -R "$SITE_PACKAGES/pdf2zh_next/." "$SOURCE_ROOT/pdf2zh_next/"
cp -R "$SITE_PACKAGES/babeldoc/." "$SOURCE_ROOT/babeldoc/"
cp "$SITE_PACKAGES/pdf2zh_next-2.9.0.dist-info/licenses/LICENSE" "$SOURCE_ROOT/pdf2zh-next-LICENSE.txt"
cp "$SITE_PACKAGES/babeldoc-0.6.2.dist-info/licenses/LICENSE" "$SOURCE_ROOT/babeldoc-LICENSE.txt"
cp "$ROOT/backend/pdf_engine/entrypoint.py" "$SOURCE_ROOT/workbench-pdf-engine-entrypoint.py"
cat > "$SOURCE_ROOT/README.txt" <<'NOTICE'
PDF translation helper source bundle

pdf2zh-next 2.9.0 (GNU AGPL v3.0): ./pdf2zh_next and pdf2zh-next-LICENSE.txt
BabelDOC 0.6.2 (GNU AGPL v3.0): ./babeldoc and babeldoc-LICENSE.txt
The workbench integration entry point is workbench-pdf-engine-entrypoint.py.
NOTICE

RUNTIME_BINARY_ARGUMENTS=()
while IFS= read -r -d '' LIBRARY; do
  RELATIVE="${LIBRARY#"$SITE_PACKAGES"/}"
  RUNTIME_BINARY_ARGUMENTS+=(--add-binary "$LIBRARY:${RELATIVE%/*}")
done < <(find "$SITE_PACKAGES" -type f -name '*.dylib' -print0)

cd "$ROOT"
"$PYTHON" -m PyInstaller \
  --noconfirm --onedir --console --name workbench-pdf-engine \
  --distpath "$ROOT/backend/dist" \
  --workpath "$ROOT/backend/build-pdf-engine-macos" \
  --specpath "$ROOT/backend/build-pdf-engine-macos" \
  "${RUNTIME_BINARY_ARGUMENTS[@]}" \
  --collect-all pdf2zh_next --collect-all babeldoc --collect-all tiktoken --collect-all bitstring \
  --hidden-import tiktoken_ext.openai_public \
  --hidden-import scipy._external.array_api_compat.numpy.fft \
  backend/pdf_engine/entrypoint.py

test -x "$ROOT/backend/dist/workbench-pdf-engine/workbench-pdf-engine"
file "$ROOT/backend/dist/workbench-pdf-engine/workbench-pdf-engine"
