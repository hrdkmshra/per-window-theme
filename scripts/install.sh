#!/usr/bin/env bash
# Symlink this extension into ~/.vscode/extensions so VS Code loads it unpacked.
# Edit extension.js, then "Developer: Reload Window" to pick up changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.vscode/extensions/local.per-window-theme-0.0.1"

if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
	echo "refusing to touch $DEST — it exists and is not a symlink" >&2
	exit 1
fi

ln -sfn "$ROOT" "$DEST"
echo "linked $DEST -> $SRC"
echo "now: fully quit VS Code (Cmd+Q) and reopen, so the extension is scanned."
