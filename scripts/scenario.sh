#!/usr/bin/env bash
# End-to-end behaviour check in a real VS Code window.
#
# Uses an isolated --user-data-dir and --extensions-dir, so it cannot disturb your
# editor, settings, or installed extensions. Proves the runtime behaviour that unit
# tests cannot reach: an opted-in window repaints, a global theme change cannot take
# that theme away, dropping the setup hands the window back, and an unopted window
# follows the global theme.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$(mktemp -d "${TMPDIR:-/tmp}/pwt-scenario-XXXXXX")"
UD="$RUN/user-data"
EXT="$RUN/extensions"
OUT="$RUN/report.json"
mkdir -p "$UD/User" "$EXT"

command -v code >/dev/null 2>&1 || { echo "the 'code' CLI is not on PATH" >&2; exit 1; }

rm -f "$EXT/extensions.json"
ln -sfn "$ROOT" "$EXT/local.per-window-theme-0.0.1"

# Note: no unmappedStrategy here, so the shipped default ('global') is what runs.
cat > "$UD/User/settings.json" <<'EOF'
{
	"workbench.colorTheme": "Dark Modern",
	"workbench.startupEditor": "none",
	"window.restoreWindows": "none",
	"telemetry.telemetryLevel": "off",
	"update.mode": "none"
}
EOF

echo "running scenario in a throwaway VS Code (isolated dirs under $RUN)"
PWT_SCENARIO_OUT="$OUT" code \
	--user-data-dir "$UD" \
	--extensions-dir "$EXT" \
	--disable-workspace-trust \
	--skip-release-notes \
	--skip-welcome \
	--new-window >"$RUN/code.log" 2>&1 &

DEADLINE=$((SECONDS + 120))
while [ ! -f "$OUT" ] && [ $SECONDS -lt $DEADLINE ]; do
	sleep 1
done

pkill -f "$UD" 2>/dev/null || true
sleep 1
pgrep -f "$UD" >/dev/null 2>&1 && pkill -9 -f "$UD" || true

if [ ! -f "$OUT" ]; then
	echo "FAIL: no report produced within 120s — the extension did not activate." >&2
	find "$UD/logs" -name exthost.log 2>/dev/null | head -1 >&2
	echo "run dir kept: $RUN" >&2
	exit 1
fi

echo
node -e '
const r = require(process.argv[1]);
console.log(`vscode ${r.vscodeVersion}`);
console.log("");
for (const s of r.steps) {
	const ok = s.kind === s.expectedKind;
	console.log(`${ok ? "PASS" : "FAIL"}  ${s.step}`);
	console.log(`      kind=${s.kind} (expected ${s.expectedKind})  theme=${s.theme}  overriding=${s.overriding}`);
	console.log(`      reason="${s.source}"  global="${s.globalSetting}"  strategy=${s.strategy}`);
}
console.log("");
console.log(r.passed ? "scenario passed" : `scenario FAILED: ${r.failures.join("; ")}`);
process.exit(r.passed ? 0 : 1);
' "$OUT"
STATUS=$?

echo
echo "raw report: $OUT"
exit $STATUS
