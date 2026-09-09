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

# Drop only THIS extension's entry from the profile's installed-extensions list, so
# VS Code re-reads our manifest on next start. Never delete the whole file: it is the
# installed-extensions list for the profile, not a throwaway cache, and wiping it
# makes every other extension look uninstalled.
MANIFEST="$EXT_DIR/extensions.json"
if [ -f "$MANIFEST" ] && command -v node >/dev/null 2>&1; then
	node -e '
		const fs = require("fs");
		const file = process.argv[1], id = process.argv[2];
		try {
			const list = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!Array.isArray(list)) { process.exit(0); }
			const kept = list.filter(e => !(e.identifier && e.identifier.id === id));
			if (kept.length !== list.length) { fs.writeFileSync(file, JSON.stringify(kept)); }
		} catch { /* malformed: leave it for VS Code to rebuild */ }
	' "$MANIFEST" "$(field publisher).$(field name)"
fi

echo "linked $DEST"
echo "    -> $ROOT"
echo
echo "next: fully quit VS Code (Cmd+Q on macOS, not just closing the window) and reopen."
echo "then: open two windows — each should get its own theme."
echo
echo "using a private/.vsix theme (e.g. Dracula Pro)? also run:"
echo "    $ROOT/scripts/builtin-farm.sh ~/.vscode/extensions/<theme-extension-dir>"
