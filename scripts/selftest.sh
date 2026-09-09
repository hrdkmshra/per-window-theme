#!/usr/bin/env bash
# Verify the core mechanism against a throwaway VS Code instance.
#
# Uses an isolated --user-data-dir and --extensions-dir, so it cannot disturb your
# real editor, settings, or installed extensions. Answers .spec/SPEC.md C1/T3: which
# installed themes can previewColorTheme actually resolve on this machine.
#
# Usage: ./selftest.sh [extra-theme-extension-dir ...]
#        ./selftest.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$(mktemp -d "${TMPDIR:-/tmp}/pwt-selftest-XXXXXX")"
UD="$RUN/user-data"
EXT="$RUN/extensions"
OUT="$RUN/report.json"
mkdir -p "$UD/User" "$EXT"

if ! command -v code >/dev/null 2>&1; then
	echo "the 'code' CLI is not on PATH — in VS Code run: Shell Command: Install 'code' command in PATH" >&2
	exit 1
fi

# The extension under test.
# Drop VS Code's scanned-extension cache, or a manifest change (e.g. a new "main")
# is ignored and activation fails against the old path.
rm -f "$EXT/extensions.json"
ln -sfn "$ROOT" "$EXT/local.per-window-theme-0.0.1"

# BUILTIN_FARM=1 tests the .spec/SPEC.md §4 fallback: extra theme extensions are placed in
# a farm of symlinks to the real built-in extensions and handed to
# --builtin-extensions-dir, which makes them scan as ExtensionType.System so
# findBuiltInThemes matches them locally with no gallery round-trip.
BUILTIN_FARM="${BUILTIN_FARM:-0}"
APP_EXT="/Applications/Visual Studio Code.app/Contents/Resources/app/extensions"
FARM="$RUN/builtins"
BUILTIN_ARGS=()

if [ "$BUILTIN_FARM" = "1" ]; then
	if [ ! -d "$APP_EXT" ]; then
		echo "cannot find built-in extensions at $APP_EXT" >&2
		exit 1
	fi
	mkdir -p "$FARM"
	for d in "$APP_EXT"/*; do
		[ -e "$d" ] || continue
		ln -sfn "$d" "$FARM/$(basename "$d")"
	done
	# Built-in scanning reads these sidecar files when present.
	for f in "$APP_EXT"/../extensions.json "$APP_EXT"/../builtin.json; do
		[ -f "$f" ] && cp "$f" "$FARM/" 2>/dev/null || true
	done
	BUILTIN_ARGS=(--builtin-extensions-dir "$FARM")
	echo "built-in farm: $(find "$FARM" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ') entries"
fi

# Any extra theme extensions to include in the probe.
for extra in "$@"; do
	if [ ! -d "$extra" ]; then
		echo "not a directory, skipping: $extra" >&2
		continue
	fi
	if [ "$BUILTIN_FARM" = "1" ]; then
		ln -sfn "$(cd "$extra" && pwd)" "$FARM/$(basename "$extra")"
		echo "probing as BUILT-IN: $(basename "$extra")"
	else
		ln -sfn "$(cd "$extra" && pwd)" "$EXT/$(basename "$extra")"
		echo "probing as user extension: $(basename "$extra")"
	fi
done

echo '{}' > "$UD/User/settings.json"
BEFORE="$(shasum "$UD/User/settings.json" | awk '{print $1}')"

# An empty window, trust disabled: a folder in a fresh user-data-dir would be
# untrusted, and a restricted window does not activate the extension at all.
echo "launching throwaway VS Code (isolated dirs under $RUN)"
PWT_SELFTEST_OUT="$OUT" code \
	--user-data-dir "$UD" \
	--extensions-dir "$EXT" \
	${BUILTIN_ARGS[@]+"${BUILTIN_ARGS[@]}"} \
	--disable-workspace-trust \
	--skip-release-notes \
	--skip-welcome \
	--new-window >"$RUN/code.stdout" 2>"$RUN/code.stderr" &
CODE_PID=$!

# The extension writes the report and then quits; poll rather than --wait, which
# needs a file argument to wait on.
DEADLINE=$((SECONDS + 90))
while [ ! -f "$OUT" ] && [ $SECONDS -lt $DEADLINE ]; do
	sleep 1
done

# Stop the throwaway instance whether or not it quit itself.
pkill -f "user-data-dir $UD" 2>/dev/null || true
pkill -f "$UD" 2>/dev/null || true
wait "$CODE_PID" 2>/dev/null || true

if [ ! -f "$OUT" ]; then
	echo "FAIL: no report produced within 90s — the extension did not activate." >&2
	echo "check the extension host log:" >&2
	find "$UD/logs" -name exthost.log 2>/dev/null | head -1 >&2
	echo "run dir kept for inspection: $RUN" >&2
	exit 1
fi

AFTER="$(shasum "$UD/User/settings.json" | awk '{print $1}')"

echo
echo "=== report ==="
node -e '
const r = require(process.argv[1]);
console.log(`vscode version         : ${r.vscodeVersion}`);
console.log(`previewColorTheme cmd  : ${r.commandAvailable ? "present" : "MISSING (mechanism is gone)"}`);
console.log(`theme kind at start    : ${r.startingThemeKind}`);
console.log(`themes resolved        : ${r.resolved} / ${r.themes.length}`);
console.log("");
for (const t of r.themes) {
	console.log(`${t.resolved ? "PASS" : "FAIL"}  ${t.settingsId.padEnd(28)} kind=${String(t.kindAfter).padEnd(18)} ${t.extensionId}@${t.version}${t.error ? "  error=" + t.error : ""}`);
}
const kinds = new Set(r.themes.filter(t => t.resolved).map(t => t.kindAfter));
console.log("");
console.log(kinds.size > 1
	? `theme actually changed in-window: yes (observed kinds: ${[...kinds].join(", ")})`
	: "theme change NOT observable via activeColorTheme.kind (all resolved themes share one kind)");
' "$OUT"

echo
if [ "$BEFORE" = "$AFTER" ]; then
	echo "settings.json untouched: yes (T2 pass)"
else
	echo "settings.json WAS MODIFIED (T2 fail) — preview leaked a write" >&2
fi

echo
echo "raw report: $OUT"
echo "clean up with: rm -rf $RUN"
