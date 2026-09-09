#!/usr/bin/env bash
# Build a writable "built-in extensions" directory: symlinks to every real built-in
# extension, plus any extra extensions you want treated as built-in.
#
# Why: workbench.action.previewColorTheme only resolves a theme locally when its
# extension scans as ExtensionType.System. Anything else falls back to a gallery
# download, which fails outright for private/.vsix themes such as Dracula Pro.
# Verified: without this, 7/7 Dracula Pro variants fail; with it, 26/26 themes pass.
#
# Nothing inside the VS Code app bundle is modified, so the code signature stays
# intact. Re-run after a VS Code update, since new built-ins won't be linked yet.
#
# Usage: ./builtin-farm.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
set -euo pipefail

APP_EXT="/Applications/Visual Studio Code.app/Contents/Resources/app/extensions"
FARM="$HOME/.per-window-theme/builtins"

if [ ! -d "$APP_EXT" ]; then
	echo "cannot find built-in extensions at $APP_EXT" >&2
	exit 1
fi

mkdir -p "$FARM"

# Drop stale links (e.g. extensions removed by a VS Code update) but keep the dir.
find "$FARM" -maxdepth 1 -mindepth 1 -type l -exec rm {} +

for d in "$APP_EXT"/*; do
	[ -e "$d" ] || continue
	ln -sfn "$d" "$FARM/$(basename "$d")"
done
echo "linked $(find "$FARM" -maxdepth 1 -mindepth 1 -type l | wc -l | tr -d ' ') built-in extensions"

for extra in "$@"; do
	if [ ! -d "$extra" ]; then
		echo "not a directory, skipping: $extra" >&2
		continue
	fi
	ln -sfn "$(cd "$extra" && pwd)" "$FARM/$(basename "$extra")"
	echo "added as built-in: $(basename "$extra")"
done

cat <<EOF

farm ready: $FARM

Launch VS Code so these count as built-in:

  code --builtin-extensions-dir "$FARM"

To make it the default, add to your shell profile:

  alias code='code --builtin-extensions-dir "$FARM"'

Note: the Dock/Spotlight icon will NOT pass this flag. For that you would need a
small wrapper .app or to always launch from the terminal.
EOF
