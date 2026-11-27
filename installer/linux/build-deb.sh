#!/bin/sh
# Nexus b1ad1a04: packages the already-built SEA binary (dist/badge-console-host,
# built by scripts/build-sea.mjs) into a real .deb — /usr/bin install, a
# desktop launcher entry, apt/dpkg-tracked uninstall — instead of the raw
# curl|sh binary drop install/install.sh already does. dpkg-deb ships on
# every Debian/Ubuntu box (and on ubuntu-latest in CI; see
# .github/workflows/release.yml) with no extra install step.
#
# Usage: installer/linux/build-deb.sh <path-to-dist/badge-console-host> <version>
set -eu

SEA_BIN="${1:?usage: build-deb.sh <path-to-sea-binary> <version>}"
VERSION="${2:?usage: build-deb.sh <path-to-sea-binary> <version>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist"
PKG_DIR="$DIST/deb-stage"

rm -rf "$PKG_DIR" "$DIST/badge-console-host.deb"
mkdir -p "$PKG_DIR/DEBIAN" \
         "$PKG_DIR/usr/bin" \
         "$PKG_DIR/usr/share/applications" \
         "$PKG_DIR/usr/share/badge-console-host"

cp "$SEA_BIN" "$PKG_DIR/usr/share/badge-console-host/badge-console-host-bin"
chmod +x "$PKG_DIR/usr/share/badge-console-host/badge-console-host-bin"

# A thin launcher on PATH, separate from the real binary, for the same
# reason the macOS .app wraps the binary rather than running it directly:
# a desktop launcher double-click needs "start the server, then open the
# config page," not just "start the server."
cat > "$PKG_DIR/usr/bin/badge-console-host" <<'LAUNCHER'
#!/bin/sh
/usr/share/badge-console-host/badge-console-host-bin "$@" &
if [ "$1" != "--install-autostart" ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s -o /dev/null "http://127.0.0.1:4173/api/state"; then break; fi
    sleep 0.5
  done
  xdg-open "http://127.0.0.1:4173" >/dev/null 2>&1 || true
fi
wait
LAUNCHER
chmod +x "$PKG_DIR/usr/bin/badge-console-host"

cat > "$PKG_DIR/usr/share/applications/badge-console-host.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Badge Console Host
Comment=Config page + feed poller for a BadgePirates desk console badge
Exec=/usr/bin/badge-console-host
Terminal=false
Categories=Utility;
DESKTOP

cat > "$PKG_DIR/DEBIAN/control" <<CONTROL
Package: badge-console-host
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Badge Pirates LLC <admin@badgepirates.com>
Description: Host agent for BadgePirates desk console badges
 Polls feed plugins (weather, stocks, sports, Home Assistant, etc.) and
 serves a local config page on 127.0.0.1, pushing cards to a paired badge
 over LAN. Bundles its own runtime (Node SEA) — no separate Node install
 required.
CONTROL

dpkg-deb --build --root-owner-group "$PKG_DIR" "$DIST/badge-console-host.deb"

echo "Built $DIST/badge-console-host.deb"
