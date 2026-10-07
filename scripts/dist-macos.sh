#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
ARCH="${MAC_ARCH:-arm64}"
ACTUAL_ARCH="$(uname -m)"
case "$ARCH:$ACTUAL_ARCH" in
  arm64:arm64|x64:x86_64) ;;
  *) echo "Runner architecture $ACTUAL_ARCH does not match requested macOS architecture $ARCH." >&2; exit 1 ;;
esac

cd "$ROOT"
npm run build:ui
npm run build:backend:macos
npm run build:pdf-engine:macos

MAC_ICON="$RUNNER_TEMP/folio-icon-$ARCH.icns"
ICONSET="$RUNNER_TEMP/folio-icon-$ARCH.iconset"
mkdir -p "$ICONSET"
for SIZE in 16 32 128 256 512; do
  sips -z "$SIZE" "$SIZE" "$ROOT/assets/folio-icon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  DOUBLE_SIZE=$((SIZE * 2))
  sips -z "$DOUBLE_SIZE" "$DOUBLE_SIZE" "$ROOT/assets/folio-icon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$MAC_ICON"
VERSION="$(node -p 'require("./package.json").version')"
OUTPUT="$ROOT/dist/macos-test-$VERSION-$ARCH"
node node_modules/electron-builder/cli.js \
  --mac zip --"$ARCH" --publish never \
  --config.directories.output="$OUTPUT" \
  --config.mac.icon="$MAC_ICON"

if [[ "$ARCH" == "x64" ]]; then
  APP="$OUTPUT/mac/阅川 Folio.app"
else
  APP="$OUTPUT/mac-$ARCH/阅川 Folio.app"
fi
codesign --verify --deep --strict "$APP"
echo "Built macOS test package: $OUTPUT"
