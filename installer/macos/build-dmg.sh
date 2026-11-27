#!/bin/sh
# Nexus b1ad1a04: wraps the already-built SEA binary (dist/badge-console-host,
# built by scripts/build-sea.mjs — this script never rebuilds it) in a
# minimal .app so Gatekeeper, Spotlight, and a double-click all treat it like
# a normal Mac app instead of a bare executable, then packages that .app into
# a .dmg a buyer drags to Applications.
#
# No Xcode project, no Info.plist generator dependency — just mkdir + a
# hand-written Info.plist + hdiutil, all of which ship with every macOS
# release. Run on macos-latest in CI (see .github/workflows/release.yml);
# can also run on a real Mac for a local test build.
#
# Usage: installer/macos/build-dmg.sh <path-to-dist/badge-console-host> <version>
set -eu

SEA_BIN="${1:?usage: build-dmg.sh <path-to-sea-binary> <version>}"
VERSION="${2:?usage: build-dmg.sh <path-to-sea-binary> <version>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist"
APP_DIR="$DIST/Badge Console Host.app"
STAGE_DIR="$DIST/dmg-stage"

rm -rf "$APP_DIR" "$STAGE_DIR" "$DIST/badge-console-host.dmg"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$SEA_BIN" "$APP_DIR/Contents/MacOS/badge-console-host-bin"
chmod +x "$APP_DIR/Contents/MacOS/badge-console-host-bin"

# The .app's actual launch target: starts the server in the background,
# then opens the config page once it's actually listening — a fixed `sleep`
# would be a flaky stand-in for "the server is ready," so this polls the
# real port instead, the same reasoning as the Windows installer's ping-wait.
cat > "$APP_DIR/Contents/MacOS/badge-console-host" <<'LAUNCHER'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/badge-console-host-bin" >/dev/null 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:4173/api/state"; then break; fi
  sleep 0.5
done
open "http://127.0.0.1:4173"
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/badge-console-host"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Badge Console Host</string>
  <key>CFBundleDisplayName</key><string>Badge Console Host</string>
  <key>CFBundleIdentifier</key><string>com.badgepirates.badge-console-host</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>badge-console-host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><false/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

# Ad-hoc signing only (codesign -s -), the same as scripts/build-sea.mjs
# already does for the raw binary — removes the "is damaged and can't be
# opened" failure mode a totally unsigned app hits on recent macOS, but
# still trips Gatekeeper's "unidentified developer" prompt on first open.
# See docs/DECISIONS.md "Code signing" for the real Apple Developer Program
# option/cost (Nexus b1ad1a04) — not applied here, this is not that.
codesign --force --deep --sign - "$APP_DIR" || true

mkdir -p "$STAGE_DIR"
cp -R "$APP_DIR" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"

hdiutil create -volname "Badge Console Host" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DIST/badge-console-host.dmg"

echo "Built $DIST/badge-console-host.dmg"
