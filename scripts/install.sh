#!/usr/bin/env bash
# Package this extension and install it through VS Code's own CLI.
#
# This replaces an earlier approach that symlinked the repo into
# ~/.vscode/extensions and edited extensions.json by hand. That file is the profile's
# installed-extensions list, not a cache, and editing it made every other extension
# look uninstalled. `code --install-extension` is the supported path: it writes that
# list correctly and copies the files, so editing this repo no longer mutates the
# running editor.
#
# Uses a prebuilt .vsix from dist/ when vsce is unavailable, so a plain clone can
# still install with no npm install and no network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" package.json | head -1; }
NAME="$(field name)"
VERSION="$(field version)"
VSIX="dist/$NAME-$VERSION.vsix"

command -v code >/dev/null 2>&1 || {
	echo "the 'code' CLI is not on PATH." >&2
	echo "In VS Code: Shell Command: Install 'code' command in PATH." >&2
	exit 1
}

if [ -x node_modules/.bin/vsce ]; then
	echo "packaging $NAME $VERSION"
	mkdir -p dist
	npm run --silent package >/dev/null
elif [ -f "$VSIX" ]; then
	echo "vsce not installed; using the prebuilt $VSIX"
else
	echo "no $VSIX and no vsce to build one." >&2
	echo "run: npm install   (then re-run this script)" >&2
	exit 1
fi

# Newest matching vsix, in case the version in package.json moved on.
VSIX="$(ls -t dist/"$NAME"-*.vsix 2>/dev/null | head -1)"
[ -n "$VSIX" ] || { echo "no vsix found in dist/" >&2; exit 1; }

echo "installing $VSIX"
code --install-extension "$VSIX" --force

cat <<MSG

installed. Reload VS Code (Developer: Reload Window) to pick it up — a full quit is
only needed if the extension does not appear.
MSG
