#!/bin/bash
# Builds DownbeatMixBridge.tar.gz: copy it to a rig Mac Mini, open it in Finder, then
# double-click install.command. Same bundle for every rig (dLive or Wing).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$PWD}"
WORK="$(mktemp -d)"
mkdir -p "$WORK/DownbeatMixBridge"
cp -R "$ROOT" "$WORK/DownbeatMixBridge/mix-bridge"
rm -rf "$WORK/DownbeatMixBridge/mix-bridge/"{test,logs,dist,.git,.github,node_modules}
cp "$ROOT/deploy/install.sh" "$ROOT/deploy/install.command" "$WORK/DownbeatMixBridge/"
chmod +x "$WORK/DownbeatMixBridge/install.sh" "$WORK/DownbeatMixBridge/install.command"
tar -czf "$OUT/DownbeatMixBridge.tar.gz" -C "$WORK" DownbeatMixBridge
rm -rf "$WORK"
( cd "$OUT" && { command -v sha256sum >/dev/null && sha256sum DownbeatMixBridge.tar.gz || shasum -a 256 DownbeatMixBridge.tar.gz; } > SHA256SUMS )
echo "$OUT/DownbeatMixBridge.tar.gz"
echo "$OUT/SHA256SUMS"
