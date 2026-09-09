#!/usr/bin/env bash
# Launch two sandboxed VS Code windows with different themes, for hands-on testing.
#
# Everything lives under a demo directory with its own --user-data-dir and
# --extensions-dir, so your real editor, settings and extensions are untouched and
# you do not need to quit VS Code. The built-in farm is included so private/.vsix
# themes (Dracula Pro) resolve offline.
#
# Usage: ./demo.sh [extra-theme-extension-dir ...]
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO="${PWT_DEMO_DIR:-/tmp/pwt-demo}"
UD="$DEMO/user-data"
EXT="$DEMO/extensions"
FARM="$DEMO/builtins"
APP_EXT="/Applications/Visual Studio Code.app/Contents/Resources/app/extensions"

# Themes for window 1 and window 2. Deliberately dark vs light so the difference
# is unmistakable at a glance.
THEME_1="${PWT_THEME_1:-Dracula Pro}"
THEME_2="${PWT_THEME_2:-Light Modern}"

if ! command -v code >/dev/null 2>&1; then
	echo "the 'code' CLI is not on PATH" >&2
	exit 1
fi

# Make repeat runs deterministic: close any sandbox windows still open from a
# previous run and drop their slot claims, so we always start from slot 0.
if pgrep -f "$UD" >/dev/null 2>&1; then
	echo "closing sandbox windows from a previous run"
	pkill -f "$UD" || true
	sleep 3
fi

mkdir -p "$UD/User" "$EXT" "$FARM"
REG="$UD/User/globalStorage/local.per-window-theme/windows.json"
[ -f "$REG" ] && : > "$REG" || true
# Killed windows would otherwise be restored on next launch, adding extra windows.
find "$UD/Backups" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

# The extension under test.
ln -sfn "$SRC" "$EXT/local.per-window-theme-0.0.1"

# Built-in farm, so non-gallery themes resolve locally (SPEC.md §4).
find "$FARM" -maxdepth 1 -mindepth 1 -type l -exec rm {} + 2>/dev/null || true
for d in "$APP_EXT"/*; do
	[ -e "$d" ] || continue
	ln -sfn "$d" "$FARM/$(basename "$d")"
done
for extra in "$@"; do
	[ -d "$extra" ] || continue
	ln -sfn "$(cd "$extra" && pwd)" "$FARM/$(basename "$extra")"
	echo "added as built-in: $(basename "$extra")"
done

cat > "$UD/User/settings.json" <<EOF
{
	"perWindowTheme.themes": [
		"$THEME_1",
		"$THEME_2"
	],
	"workbench.colorTheme": "Dark Modern",
	"window.newWindowProfile": "Default",
	"workbench.startupEditor": "none",
	"window.restoreWindows": "none",
	"telemetry.telemetryLevel": "off",
	"update.mode": "none"
}
EOF

LAUNCH=(code
	--user-data-dir "$UD"
	--extensions-dir "$EXT"
	--builtin-extensions-dir "$FARM"
	--disable-workspace-trust
	--skip-release-notes
	--skip-welcome
	--new-window)

echo "window 1 -> slot 0 -> \"$THEME_1\""
"${LAUNCH[@]}" >"$DEMO/window1.log" 2>&1 &
sleep 14

echo "window 2 -> slot 1 -> \"$THEME_2\""
"${LAUNCH[@]}" >"$DEMO/window2.log" 2>&1 &
sleep 10

echo
if [ -f "$REG" ]; then
	echo "=== slot registry ==="
	cat "$REG"
	echo
	node -e '
const fs = require("fs");
const claims = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).claims || [];
const now = Date.now();
const live = claims.filter(c => now - c.ts < 20000);
const slots = new Set(live.map(c => c.slot));
console.log(`live windows: ${live.length}, distinct slots: ${slots.size} -> ${[...slots].sort().join(", ")}`);
console.log(live.length >= 2 && slots.size === live.length
	? "PASS: every live window holds its own slot"
	: "CHECK: expected 2 live windows on distinct slots");
' "$REG"
else
	echo "registry not found at $REG — the extension may not have activated"
	echo "check: $(find "$UD/logs" -name exthost.log 2>/dev/null | head -1)"
fi

cat <<EOF

Two sandboxed windows are open. Things to try:

  1. Look at them side by side - different themes, at the same time, no workspace.
  2. In either window: Cmd+Shift+P -> "Per-Window Theme: Show Status"
  3. Cmd+Shift+P -> "Per-Window Theme: Cycle Theme (This Window)" - only that window changes.
  4. Cmd+K Cmd+T and pick any theme - both windows snap back to their own within ~1s (T5).
  5. Cmd+Shift+P -> "Developer: Reload Window" - brief flash, then its own theme returns (T6).
  6. Close window 1, open a new one (Cmd+Shift+N) - it takes the freed slot 0 (T7).

Sandbox: $DEMO
Tear down: close both windows, then delete $DEMO
EOF
