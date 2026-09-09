#!/usr/bin/env bash
# Symlink this extension into ~/.vscode/extensions so VS Code loads it unpacked.
# Edit any file under src/, then "Developer: Reload Window" to pick up changes.
#
# Env:
#   PWT_EXT_DIR   where to link (default ~/.vscode/extensions; VS Code Insiders
#                 uses ~/.vscode-insiders/extensions)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${PWT_EXT_DIR:-$HOME/.vscode/extensions}"

# Read publisher/name/version from package.json so the link name always matches the
# manifest. Kept to grep/sed so this works without node installed.
field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$ROOT/package.json" | head -1; }
PUBLISHER="$(field publisher)"
NAME="$(field name)"
VERSION="$(field version)"

if [ -z "$PUBLISHER" ] || [ -z "$NAME" ] || [ -z "$VERSION" ]; then
	echo "could not read publisher/name/version from $ROOT/package.json" >&2
	exit 1
fi

DEST="$EXT_DIR/$PUBLISHER.$NAME-$VERSION"

if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
	echo "refusing to touch $DEST — it exists and is not a symlink" >&2
	echo "move it aside yourself, then re-run." >&2
	exit 1
fi

mkdir -p "$EXT_DIR"
ln -sfn "$ROOT" "$DEST"

# VS Code caches scanned manifests; a stale cache makes a changed "main" fail.
rm -f "$EXT_DIR/extensions.json"

echo "linked $DEST"
echo "    -> $ROOT"
echo
echo "next: fully quit VS Code (Cmd+Q on macOS, not just closing the window) and reopen."
echo "then: open two windows — each should get its own theme."
echo
echo "using a private/.vsix theme (e.g. Dracula Pro)? also run:"
echo "    $ROOT/scripts/builtin-farm.sh ~/.vscode/extensions/<theme-extension-dir>"
