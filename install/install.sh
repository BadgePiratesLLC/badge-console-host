#!/bin/sh
# macOS / Linux one-line install. Downloads the release binary for this
# OS, puts it somewhere on PATH-ish that doesn't need sudo, and registers
# it to start on login. No compiler, no npm, no terminal needed again
# after this.
#
# Usage (once a release exists):
#   curl -fsSL https://raw.githubusercontent.com/BadgePiratesLLC/badge-console-host/main/install/install.sh | sh
set -eu

REPO="BadgePiratesLLC/badge-console-host"
INSTALL_DIR="$HOME/.badge-console-host/bin"

os=$(uname -s)
case "$os" in
  Darwin) asset="badge-console-host-macos" ;;
  Linux) asset="badge-console-host-linux" ;;
  *) echo "install.sh only supports macOS and Linux — see install/install.ps1 for Windows." >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR"
url="https://github.com/$REPO/releases/latest/download/$asset"
echo "Downloading $url"
curl -fsSL "$url" -o "$INSTALL_DIR/badge-console-host"
chmod +x "$INSTALL_DIR/badge-console-host"

echo "Registering to start on login…"
BCH_SEA_BUILD=1 "$INSTALL_DIR/badge-console-host" --install-autostart

echo "Starting now…"
BCH_SEA_BUILD=1 nohup "$INSTALL_DIR/badge-console-host" >/dev/null 2>&1 &

echo
echo "Done. Open http://127.0.0.1:4173 in your browser to finish setup."
