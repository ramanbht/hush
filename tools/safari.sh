#!/bin/bash
# Wraps dist/safari in a macOS app with Xcode's converter and builds it.
# Needs full Xcode (not just the command-line tools).
#
#   tools/safari.sh                       uses bundle id local.hush.adblocker
#   BUNDLE_ID=com.you.hush tools/safari.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f dist/safari/manifest.json ] || node tools/build.mjs --target=safari

OUT=safari-app
rm -rf "$OUT"
xcrun safari-web-extension-converter dist/safari \
  --project-location "$OUT" \
  --app-name Hush \
  --bundle-identifier "${BUNDLE_ID:-local.hush.adblocker}" \
  --macos-only --swift --copy-resources --no-open --force

PROJECT=$(find "$OUT" -name '*.xcodeproj' -maxdepth 3 | head -1)
SCHEME=$(xcodebuild -list -project "$PROJECT" | awk '/Schemes:/{f=1;next} f&&NF{print;exit}' | xargs)
echo "Building scheme '$SCHEME' from $PROJECT"
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  CONFIGURATION_BUILD_DIR="$PWD/$OUT/build" CODE_SIGN_IDENTITY="-" build | tail -3

open "$OUT/build/Hush.app"
cat <<'EOF'

Next, in Safari:
  1. Settings > Developer > check "Allow unsigned extensions" (resets each time Safari quits).
  2. Settings > Extensions > enable Hush.
  3. Click Hush > "Always Allow on Every Website" so element hiding and fixes can run.
EOF
