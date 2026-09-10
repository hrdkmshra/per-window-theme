'use strict';

const vscode = require('vscode');
const fsp = require('fs/promises');

/**
 * End-to-end behaviour check, run inside a real VS Code window against a fully
 * activated extension. Only fires when PWT_SCENARIO_OUT is set, so it can never run
 * in a normal editor session. Writes a JSON record of each step, then quits.
 *
 * It proves the things unit tests cannot:
 *   - an opted-in window really repaints
 *   - a global theme change cannot take that window's theme away
 *   - losing the per-window setup hands the window back to the global theme
 *   - a window with no setup follows the global theme instead
 */

const KIND_NAMES = { 1: 'Light', 2: 'Dark', 3: 'HighContrast', 4: 'HighContrastLight' };
const kindName = k => KIND_NAMES[k] || String(k);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** How long to wait for a stomp plus our debounced re-apply to settle. */
const SETTLE_MS = 1500;

async function setGlobalTheme(id) {
	await vscode.workspace.getConfiguration().update(
		'workbench.colorTheme', id, vscode.ConfigurationTarget.Global);
}

function snapshot(ctrl, step, expected) {
	return {
		step,
		expectedKind: expected,
		kind: kindName(vscode.window.activeColorTheme.kind),
		theme: ctrl.theme,
		source: ctrl.source,
		overriding: ctrl.overriding,
		globalSetting: vscode.workspace.getConfiguration().get('workbench.colorTheme'),
		strategy: vscode.workspace.getConfiguration('perWindowTheme').get('unmappedStrategy')
	};
}

async function run(outPath, ctrl) {
	const steps = [];

	// Baseline: nothing opted in, so the workbench owns this window.
	steps.push(snapshot(ctrl, 'baseline: no per-window setup', 'Dark'));

	// 1a. Walking the theme picker previews without committing: the window repaints,
	//     but no pin is set and nothing is written to folder memory.
	const beforePreview = ctrl.snapshot();
	await ctrl.previewTheme('Light Modern');
	await sleep(300);
	steps.push(snapshot(ctrl, 'previewing Light Modern repaints the window', 'Light'));

	// 1b. Cancelling the picker puts the window back exactly as it was.
	await ctrl.restoreSnapshot(beforePreview, 'scenario: picker cancelled');
	await sleep(400);
	steps.push(snapshot(ctrl, 'cancelling the picker reverts to the global theme', 'Dark'));

	// 2. Opt this window in explicitly. Light Modern is a Light theme, so a real
	//    repaint is observable through activeColorTheme.kind.
	await ctrl.pinTheme('Light Modern');
	await sleep(300);
	steps.push(snapshot(ctrl, 'after explicit pick of Light Modern', 'Light'));

	// 3. Change the global theme to a Dark one. The workbench pushes it into every
	//    window; ours must come back.
	await setGlobalTheme('Abyss');
	await sleep(SETTLE_MS);
	steps.push(snapshot(ctrl, 'global changed to Abyss (Dark): per-window theme must survive', 'Light'));

	// 4. Drop the per-window setup. With strategy 'global' the window should be
	//    handed back to the current global theme, which is now Abyss (Dark).
	await ctrl.unpin('scenario: dropped the per-window setup');
	await sleep(600);
	steps.push(snapshot(ctrl, 'per-window setup removed: hand back to global Abyss', 'Dark'));

	// 5. A window with no setup must follow a later global change.
	await setGlobalTheme('Light Modern');
	await sleep(SETTLE_MS);
	steps.push(snapshot(ctrl, 'global changed to Light Modern: unopted window follows', 'Light'));

	const report = {
		vscodeVersion: vscode.version,
		steps,
		failures: steps.filter(s => s.kind !== s.expectedKind).map(s => s.step)
	};
	report.passed = report.failures.length === 0;

	await fsp.writeFile(outPath, JSON.stringify(report, null, '\t'), 'utf8');
	await vscode.commands.executeCommand('workbench.action.quit');
}

module.exports = { run };
