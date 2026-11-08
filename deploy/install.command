#!/bin/bash
# Double-click in Finder to install or update the Downbeat mix bridge on this Mac.
cd "$(dirname "$0")" && ./install.sh 2>&1 | tee "$HOME/Documents/DownbeatMix-install.log"
