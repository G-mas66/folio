#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
BUILD_TEMP="$RUNNER_TEMP/folio-pdf-engine-build"
VENV="$RUNNER_TEMP/folio-pdf-engine-venv"
PYTHON="$VENV/bin/python"
mkdir -p "$BUILD_TEMP" "$RUNNER_TEMP/folio-pdf-engine-pip-cache" "$RUNNER_TEMP/folio-pdf-engine-pyinstaller-cache" "$RUNNER_TEMP/folio-pdf-engine-home" "$ROOT/backend/dist" "$ROOT/backend/build-pdf-engine-macos"
export TMPDIR="$BUILD_TEMP"
export PIP_CACHE_DIR="$RUNNER_TEMP/folio-pdf-engine-pip-cache"
export PYINSTALLER_CONFIG_DIR="$RUNNER_TEMP/folio-pdf-engine-pyinstaller-cache"
export WORKBENCH_PDF_ENGINE_BUILD_HOME="$RUNNER_TEMP/folio-pdf-engine-home"

python3 -m venv --clear "$VENV"
"$PYTHON" -m pip install --quiet --disable-pip-version-check --only-binary=cryptography 'pdf2zh-next==2.9.0' 'babeldoc==0.6.2' 'pyinstaller==6.16.0'

SITE_PACKAGES="$("$PYTHON" -c 'import site; print(site.getsitepackages()[0])')"
CRYPTOGRAPHY_RUST="$SITE_PACKAGES/cryptography/hazmat/bindings/_rust.abi3.so"
test -f "$CRYPTOGRAPHY_RUST"
if otool -L "$CRYPTOGRAPHY_RUST" | grep -E '/lib(ssl|crypto)\.[0-9]+\.dylib'; then
  echo "cryptography must use its statically linked macOS wheel, not a Homebrew OpenSSL dylib." >&2
  exit 1
fi
"$PYTHON" -c 'import cryptography; from cryptography.hazmat.primitives import hashes; digest = hashes.Hash(hashes.SHA256()); digest.update(b"Folio macOS PDF engine"); digest.finalize(); print("PDF_ENGINE_CRYPTOGRAPHY_STATIC_WHEEL=" + cryptography.__version__)'
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
  --hidden-import cryptography.hazmat.bindings._rust \
  --hidden-import tiktoken_ext.openai_public \
  --hidden-import scipy._external.array_api_compat.numpy.fft \
  --runtime-hook "$ROOT/backend/pdf_engine/macos_cryptography_self_test.py" \
  backend/pdf_engine/entrypoint.py

test -x "$ROOT/backend/dist/workbench-pdf-engine/workbench-pdf-engine"
file "$ROOT/backend/dist/workbench-pdf-engine/workbench-pdf-engine"
