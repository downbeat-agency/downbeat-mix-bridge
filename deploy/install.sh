#!/bin/bash
# Installs or updates the Downbeat mix bridge on a rig Mac Mini (dLive or Wing):
# Node 22 (in ~/DownbeatMix/node, no admin password), the bridge, a config for this
# computer, and a login item that keeps it running. Safe to run again to update.
# Usage: ./install.sh ["Rig name"]   (default: this Mac's computer name)
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/DownbeatMix"
mkdir -p "$DEST/logs"

if [ ! -x "$DEST/node/bin/node" ]; then
  BASE="https://nodejs.org/dist/latest-v22.x"
  TARBALL=$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '/darwin-arm64\.tar\.gz$/ {print $2}')
  SUM=$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '/darwin-arm64\.tar\.gz$/ {print $1}')
  echo "Downloading $TARBALL"
  curl -fL --progress-bar -o "/tmp/$TARBALL" "$BASE/$TARBALL"
  echo "$SUM  /tmp/$TARBALL" | shasum -a 256 -c -
  rm -rf "$DEST/node" && mkdir -p "$DEST/node"
  tar -xzf "/tmp/$TARBALL" -C "$DEST/node" --strip-components 1
  rm -f "/tmp/$TARBALL"
fi
echo "Node $("$DEST/node/bin/node" -v)"

rm -rf "$DEST/mix-bridge" "$DEST/mix-bridge.previous" "$DEST/update-staging"
cp -R "$SRC/mix-bridge" "$DEST/mix-bridge"
rm -rf "$DEST/mix-bridge/test"
cp "$SRC/mix-bridge/deploy/launcher.js" "$DEST/launcher.js"
rm -f "$DEST/update-state.json"
# First install: a config for this computer (rig name from the Mac's name, console
# model read from Mixing Station). Later runs only update the bridge and keep the config.
if [ ! -f "$DEST/config.json" ]; then
  RIG_NAME="${1:-$(scutil --get ComputerName 2>/dev/null || hostname -s)}"
  "$DEST/node/bin/node" -e '
    const [rigName, logDir] = process.argv.slice(1);
    const config = {
      rigName, port: 8790, driver: "mixingstation", sharedToken: null, allowedBuses: null,
      maxWritesPerSecond: 400, meterIntervalMs: 100, logDir,
      mixingStation: {
        wsUrl: "ws://127.0.0.1:8091/", auth: { user: "admin", password: "" },
        consoleModel: "auto", maxInputs: null, meters: { enabled: true, intervalMs: 100 },
      },
    };
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
  ' "$RIG_NAME" "$DEST/logs" > "$DEST/config.json"
  echo "Created $DEST/config.json for rig \"$RIG_NAME\""
fi

PLIST="$HOME/Library/LaunchAgents/com.downbeat.mixbridge.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.downbeat.mixbridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEST/node/bin/node</string>
    <string>$DEST/launcher.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>$DEST/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>$DEST/logs/bridge.log</string>
</dict>
</plist>
PL
SERVICE="gui/$(id -u)/com.downbeat.mixbridge"
if launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE" 2>/dev/null || true
  # bootout returns before the old bridge has stopped; bootstrap fails (error 5) until it has.
  for _ in $(seq 1 40); do launchctl print "$SERVICE" >/dev/null 2>&1 || break; sleep 0.25; done
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
echo "--- health"
curl -fsS http://127.0.0.1:8790/health && echo
echo "--- log"
tail -n 15 "$DEST/logs/bridge.log"
echo "DONE"
