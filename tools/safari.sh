#!/bin/bash
# Builds Hush for Safari as a macOS app and installs it in ~/Applications.
# Needs macOS with full Xcode (not just the command-line tools) and Node 18+.
# Run it again any time to update: it rebuilds with fresh filter lists.
#
#   tools/safari.sh
#       Unsigned build. Safari only loads it while Settings > Developer >
#       "Allow unsigned extensions" is checked, and that resets every time
#       Safari quits.
#
#   TEAM_ID=ABCDE12345 BUNDLE_ID=io.github.yourname.hush tools/safari.sh
#       Signed with your Apple Developer Program team, so Safari keeps it
#       enabled across restarts. Find the team ID at
#       developer.apple.com/account under Membership details. Sign in to that
#       Apple ID in Xcode > Settings > Accounts first.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID=${BUNDLE_ID:-local.hush.adblocker}
OUT=safari-app
DEST="$HOME/Applications/Hush.app"

node tools/build.mjs --target=safari

# Apple renamed safari-web-extension-converter to safari-web-extension-packager.
PACKAGER=safari-web-extension-packager
xcrun --find "$PACKAGER" >/dev/null 2>&1 || PACKAGER=safari-web-extension-converter

rm -rf "$OUT"
xcrun "$PACKAGER" dist/safari \
  --project-location "$OUT" \
  --app-name Hush \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only --swift --copy-resources --no-open --no-prompt --force

if [ -n "${TEAM_ID:-}" ]; then
  SIGNING=(-allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic)
  echo "Signing with team $TEAM_ID"
else
  SIGNING=(CODE_SIGN_IDENTITY="-")
  echo "No TEAM_ID set: building unsigned"
fi

PROJECT=$(find "$OUT" -maxdepth 3 -name '*.xcodeproj' | head -1)
SCHEME=$(xcodebuild -list -project "$PROJECT" | awk '/Schemes:/{f=1;next} f&&NF{print;exit}' | xargs)
echo "Building scheme '$SCHEME' from $PROJECT"
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  CONFIGURATION_BUILD_DIR="$PWD/$OUT/build" "${SIGNING[@]}" build | tail -3

# Safari loads the extension from inside the app, so keep the app somewhere stable.
pkill -x Hush 2>/dev/null || true
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$OUT/build/Hush.app" "$DEST"
open "$DEST"
echo "Installed $DEST"

if [ -n "${TEAM_ID:-}" ]; then
  cat <<'EOF'

Next, in Safari:
  1. Settings > Extensions > enable Hush.
  2. Click Hush > "Always Allow on Every Website" so element hiding and fixes can run.
EOF
else
  cat <<'EOF'

Next, in Safari:
  1. Settings > Developer > check "Allow unsigned extensions" (resets each time Safari quits).
  2. Settings > Extensions > enable Hush.
  3. Click Hush > "Always Allow on Every Website" so element hiding and fixes can run.
EOF
fi
