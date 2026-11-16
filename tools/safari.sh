#!/bin/bash
# Builds Hush for Safari as a macOS app and installs it in ~/Applications.
# Needs macOS with full Xcode (not just the command-line tools) and Node 18+.
# Run it again any time to update: it rebuilds with fresh filter lists.
#
#   tools/safari.sh
#       Finds a code-signing identity in your keychain and signs with it, so
#       Safari keeps Hush enabled across restarts and you never touch the
#       "Allow unsigned extensions" switch again. A free Apple ID is enough:
#       sign in under Xcode > Settings > Accounts and Xcode issues an "Apple
#       Development" certificate, which is valid on this Mac for a year.
#       The README's Safari section walks through the one-time setup.
#
#   TEAM_ID=ABCDE12345 tools/safari.sh
#       Use a specific team instead of the first one found.
#
#   HUSH_UNSIGNED=1 tools/safari.sh
#       Build unsigned on purpose. Safari then loads it only while Settings >
#       Developer > "Allow unsigned extensions" is ticked, and it unticks that
#       every time Safari quits.
#
#   BUNDLE_ID=io.github.you.hush tools/safari.sh
#       Override the bundle identifier. Keep it stable: changing it makes
#       Safari treat the result as a different extension.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID=${BUNDLE_ID:-local.hush.adblocker}

# Use full Xcode even if xcode-select points at the command-line tools.
if ! xcrun --find xcodebuild >/dev/null 2>&1 || [[ "$(xcode-select -p 2>/dev/null)" == *CommandLineTools* ]]; then
  # "/Applications/Xcode*.app" also matches helper apps such as Xcodes.app, the
  # version manager, so take the first bundle that really contains xcodebuild
  # rather than whatever sorts first.
  XCODE_APP=''
  for cand in /Applications/Xcode*.app "$HOME/Applications"/Xcode*.app; do
    if [ -x "$cand/Contents/Developer/usr/bin/xcodebuild" ]; then XCODE_APP=$cand; break; fi
  done
  if [ -z "$XCODE_APP" ]; then
    cat >&2 <<'EOF'
Full Xcode is not installed. The Command Line Tools on their own have neither
xcodebuild nor safari-web-extension-converter, so they are not enough.

Note that the Mac App Store only ever offers the newest Xcode, which may require
a newer macOS than this Mac runs. To get a version that matches this machine,
use Xcodes.app ("brew install --cask xcodes-app") or developer.apple.com/download/all.
EOF
    exit 1
  fi
  export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"
  echo "Using $XCODE_APP"
fi
if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  # When xcode-select still points at the Command Line Tools, a bare
  # "sudo xcodebuild" runs the wrong one, so spell DEVELOPER_DIR out.
  if [ -n "${DEVELOPER_DIR:-}" ]; then
    FIRST_LAUNCH="sudo DEVELOPER_DIR=\"$DEVELOPER_DIR\" xcodebuild -runFirstLaunch"
  else
    FIRST_LAUNCH="sudo xcodebuild -runFirstLaunch"
  fi
  cat >&2 <<EOF
Xcode needs its one-time setup. Run:

  $FIRST_LAUNCH

It shows Apple's Xcode license first: page through it and type "agree". Then
run this script again.
EOF
  exit 1
fi
# A real signature is the whole point: Safari only keeps an extension enabled
# across restarts if the containing app is signed. Prefer a Developer ID (paid
# membership, also distributable), fall back to Apple Development (free Apple
# ID, valid on this Mac only), which is all a personal install needs.
identities() { security find-identity -v -p codesigning 2>/dev/null; }

# The Team ID is the certificate's organizational unit. It is NOT the code in
# the common name: an Apple Development certificate reads
#   CN=Apple Development: you@example.com (U2HC3AM486), OU=LPGBSPK772
# where the OU is the team and the CN's code identifies the developer.
team_from_cert() {
  security find-certificate -c "$1" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | tr ',' '\n' \
    | sed -n 's/^[[:space:]]*OU[[:space:]]*=[[:space:]]*\([A-Z0-9]\{10\}\)[[:space:]]*$/\1/p' \
    | head -1
}

find_team() {
  local kind team
  for kind in 'Developer ID Application' 'Apple Development'; do
    identities | grep -qF "\"$kind:" || continue
    team=$(team_from_cert "$kind")
    if [ -n "$team" ]; then printf '%s' "$team"; return 0; fi
  done
  return 1
}

if [ -n "${HUSH_UNSIGNED:-}" ]; then
  TEAM_ID=''
elif [ -z "${TEAM_ID:-}" ]; then
  TEAM_ID=$(find_team || true)
fi

if [ -n "${TEAM_ID:-}" ]; then
  SIGNING=(-allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic)
  echo "Signing with team $TEAM_ID"
elif [ -n "${HUSH_UNSIGNED:-}" ]; then
  SIGNING=(CODE_SIGN_IDENTITY="-")
  echo "Building unsigned (HUSH_UNSIGNED is set)"
else
  # A certificate can be in the keychain without being a usable identity.
  # Those cases need different fixes, so tell them apart.
  INVALID=$(security find-identity -p codesigning 2>/dev/null \
    | grep -E '"(Developer ID Application|Apple Development):' | head -1 || true)
  if [ -n "$INVALID" ]; then
    KIND=$(printf '%s' "$INVALID" | sed -n 's/.*"\([^:]*\):.*/\1/p')
    CERT=$(security find-certificate -c "$KIND" -p 2>/dev/null || true)
    if ! printf '%s\n' "$CERT" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
      cat >&2 <<'EOF'
Your signing certificate has expired (they last a year). Make a new one in
Xcode > Settings… > Accounts: select your team, click Manage Certificates…,
then + > Apple Development. Then run this script again.
EOF
    else
      # Valid dates but not trusted: almost always the Apple intermediate that
      # issued it is missing. Its generation (G3, G4, ...) is the issuer's OU.
      GEN=$(printf '%s\n' "$CERT" | openssl x509 -noout -issuer 2>/dev/null | tr ',' '\n' \
        | sed -n 's/^[[:space:]]*OU[[:space:]]*=[[:space:]]*\(G[0-9]*\)[[:space:]]*$/\1/p' | head -1 || true)
      if [ -n "$GEN" ]; then
        cat >&2 <<EOF
Your keychain has a signing certificate, but macOS cannot verify it: the Apple
intermediate certificate that issued it ("Apple Worldwide Developer Relations
$GEN") is missing. That is common on a Mac that has not had Xcode before.
Install it once:

  curl -fsSLO https://www.apple.com/certificateauthority/AppleWWDRCA$GEN.cer
  security import AppleWWDRCA$GEN.cer -k ~/Library/Keychains/login.keychain-db

(or download it from apple.com/certificateauthority and double-click it). It is
an intermediate, not a root: it adds no new trust, it only completes the chain
to Apple's root. Then run this script again.
EOF
      else
        cat >&2 <<'EOF'
Your keychain has a signing certificate, but macOS does not trust it. The usual
cause is a missing Apple intermediate certificate: get the "Worldwide Developer
Relations" one matching your certificate's issuer from
apple.com/certificateauthority, double-click it, and run this script again.
EOF
      fi
    fi
  else
    cat >&2 <<'EOF'
No code-signing certificate found, so Safari would forget Hush every time it
quits. A free Apple ID is enough:

  1. Xcode > Settings… > Accounts: click +, choose Apple ID, and sign in.
  2. Select your "Personal Team".
  3. If no certificate shows up, click Manage Certificates…, then + > Apple
     Development.
  4. Run this script again.

That certificate is valid on this Mac for a year, which is all a personal
install needs. To build unsigned anyway (Safari forgets it on every quit):
HUSH_UNSIGNED=1 tools/safari.sh
EOF
  fi
  exit 1
fi

OUT=safari-app
DEST="$HOME/Applications/Hush.app"

if command -v node >/dev/null 2>&1; then
  node tools/build.mjs --target=safari
elif [ -f dist/safari/manifest.json ]; then
  echo "Node not found: packaging the existing dist/safari (install Node to refresh the lists)"
else
  echo "Node 18+ is needed to build the extension (brew install node, or nodejs.org)." >&2
  exit 1
fi

# Apple renamed safari-web-extension-converter to safari-web-extension-packager.
PACKAGER=safari-web-extension-packager
xcrun --find "$PACKAGER" >/dev/null 2>&1 || PACKAGER=safari-web-extension-converter

rm -rf "$OUT"
xcrun "$PACKAGER" dist/safari \
  --project-location "$OUT" \
  --app-name Hush \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only --swift --copy-resources --no-open --no-prompt --force

PROJECT=$(find "$OUT" -maxdepth 3 -name '*.xcodeproj' | head -1)

# safari-web-extension-packager derives the two identifiers inconsistently: the
# app gets --bundle-identifier's last component swapped for the app name, while
# the extension gets "<bundle-identifier>.Extension". With anything but a
# bundle id that already ends in the app name those disagree, and Xcode refuses
# to embed the extension ("Embedded binary's bundle identifier is not prefixed
# with the parent app's bundle identifier"). Pin both rather than depend on how
# the packager derives them.
PBX="$PROJECT/project.pbxproj"
awk -v id="$BUNDLE_ID" '
  /PRODUCT_BUNDLE_IDENTIFIER = / {
    if ($0 ~ /\.Extension;[[:space:]]*$/)
      sub(/PRODUCT_BUNDLE_IDENTIFIER = [^;]*;/, "PRODUCT_BUNDLE_IDENTIFIER = " id ".Extension;")
    else
      sub(/PRODUCT_BUNDLE_IDENTIFIER = [^;]*;/, "PRODUCT_BUNDLE_IDENTIFIER = " id ";")
  }
  { print }
' "$PBX" > "$PBX.tmp" && mv "$PBX.tmp" "$PBX"
echo "Bundle identifiers: $BUNDLE_ID and $BUNDLE_ID.Extension"
SCHEME=$(xcodebuild -list -project "$PROJECT" | awk '/Schemes:/{f=1;next} f&&NF{print;exit}' | xargs)
echo "Building scheme '$SCHEME' from $PROJECT"
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  CONFIGURATION_BUILD_DIR="$PWD/$OUT/build" "${SIGNING[@]}" build | tail -3

# Safari loads the extension from inside the app, so keep the app somewhere stable.
pkill -x Hush 2>/dev/null || true
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$OUT/build/Hush.app" "$DEST"

# macOS keeps every copy of the app it has seen registered: the build output
# (xcodebuild registers it), an older install, even one in the Trash, which can
# re-register itself later. Safari then lists Hush more than once and may load
# the wrong copy, so unregister every copy but the installed one, from both the
# extension registry (PlugInKit) and LaunchServices, and delete the build output.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
other_copies() {
  { pluginkit -m -A -v -i "$BUNDLE_ID.Extension" 2>/dev/null || true; } \
    | awk -F'\t' 'NF > 1 { sub(/\/Contents\/PlugIns\/.*/, "", $NF); print $NF }'
  { "$LSREGISTER" -dump 2>/dev/null || true; } | awk -v id="$BUNDLE_ID" '
    /^-{10,}/     { if (ident == id && path != "") print path; path = ""; ident = ""; next }
    /^path:/       { p = $0; sub(/^path:[[:space:]]+/, "", p); sub(/ \(0x[0-9a-fA-F]+\)[[:space:]]*$/, "", p); path = p }
    /^identifier:/ { i = $0; sub(/^identifier:[[:space:]]+/, "", i); sub(/[[:space:]]+$/, "", i); ident = i }
    END           { if (ident == id && path != "") print path }'
}
other_copies | sort -u | while IFS= read -r app; do
  [ "$app" = "$DEST" ] && continue
  for appex in "$app"/Contents/PlugIns/*.appex; do pluginkit -r "$appex" 2>/dev/null || true; done
  "$LSREGISTER" -u "$app" 2>/dev/null || true
  echo "Unregistered another copy: $app"
done
"$LSREGISTER" -u "$PWD/$OUT/build/Hush.app" 2>/dev/null || true
rm -rf "$OUT"
"$LSREGISTER" -f "$DEST" 2>/dev/null || true
pluginkit -a "$DEST/Contents/PlugIns/Hush Extension.appex" 2>/dev/null || true

open "$DEST"
echo "Installed $DEST"

# Report what the app was actually signed with, so "will Safari still have this
# tomorrow?" is answered now instead of discovered tomorrow.
AUTHORITY=$(codesign -dvv "$DEST" 2>&1 | sed -n 's/^Authority=//p' | head -1)
if ! codesign --verify --strict "$DEST" >/dev/null 2>&1; then
  echo
  echo "WARNING: the signature on $DEST does not verify; Safari may refuse it." >&2
fi

echo
if [ -n "${TEAM_ID:-}" ]; then
  echo "Signed by: ${AUTHORITY:-unknown}"
  cat <<'EOF'

Safari keeps a signed extension enabled across restarts, so this is a one-time
setup. Next, in Safari:
  1. Settings > Extensions > enable Hush.
  2. Click Hush, then "Always Allow on Every Website". Without website access
     Safari still blocks ad requests, but element hiding and script fixes
     cannot run.

Re-run this script whenever you want fresh filter lists; the steps above stay
done, and you should never need the "Allow unsigned extensions" switch again.
EOF
else
  cat <<'EOF'
This build is UNSIGNED, so Safari forgets it every time it quits. Next:
  1. Settings > Developer > check "Allow unsigned extensions" (resets on quit).
  2. Settings > Extensions > enable Hush.
  3. Click Hush, then "Always Allow on Every Website".

Re-run without HUSH_UNSIGNED=1 to sign it and stop repeating this.
EOF
fi
