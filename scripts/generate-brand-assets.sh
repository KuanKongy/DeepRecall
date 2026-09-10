#!/usr/bin/env bash
# Regenerate favicon / app-icon / OG-image PNGs from frontend/public/icon.svg.
# Needs macOS (sips), Google Chrome and node — no npm packages.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PUB=frontend/public
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$CHROME" --headless=new --hide-scrollbars --default-background-color=00000000 \
  --window-size=512,512 --screenshot="$PUB/favicon-512.png" \
  "file://$PWD/scripts/brand/icon.html" 2>/dev/null

"$CHROME" --headless=new --hide-scrollbars \
  --window-size=1200,630 --screenshot="$PUB/og.png" \
  "file://$PWD/scripts/brand/og.html" 2>/dev/null

sips -z 192 192 "$PUB/favicon-512.png" --out "$PUB/favicon-192.png" >/dev/null
sips -z 180 180 "$PUB/favicon-512.png" --out "$PUB/apple-touch-icon.png" >/dev/null
sips -z 48 48 "$PUB/favicon-512.png" --out "$TMP/favicon-48.png" >/dev/null
node scripts/brand/png-to-ico.mjs "$TMP/favicon-48.png" "$PUB/favicon.ico"

echo "Generated: favicon-512.png favicon-192.png apple-touch-icon.png favicon.ico og.png"
