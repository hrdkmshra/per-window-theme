'use strict';

const vscode = require('vscode');
const fsp = require('fs/promises');
const { listAllThemes } = require('../theme/themeService');

/**
 * Non-interactive verification, used by scripts/selftest.sh against a throwaway VS
 * Code instance. Only ever runs when PWT_SELFTEST_OUT is set in the environment, so
 * it cannot fire in a normal editor session. Writes a JSON report, then quits.
 */

const KIND_NAMES = { 1: 'Light', 2: 'Dark', 3: 'HighContrast', 4: 'HighContrastLight' };
const kindName = k => KIND_NAMES[k] || String(k);

async function run(outPath) {
	/** @type {{settingsId: string, extensionId: string, version: string, resolved: boolean, returned: any, error: any, kindAfter: string}[]} */
	const themes = [];
	const report = {
		vscodeVersion: vscode.version,
		sessionId: vscode.env.sessionId,
		commandAvailable: (await vscode.commands.getCommands(true)).includes('workbench.action.previewColorTheme'),
		startingThemeKind: kindName(vscode.window.activeColorTheme.kind),
		themes
	};

	for (const t of listAllThemes()) {
		let applied;
		let error;
		try {
			applied = await vscode.commands.executeCommand(
				'workbench.action.previewColorTheme',
				{ publisher: t.publisher, name: t.name, version: t.version },
				t.settingsId
			);
		} catch (err) {
			error = String((err && err.message) || err);
		}
		// Let the workbench repaint so activeColorTheme reflects the new theme.
		await new Promise(r => setTimeout(r, 120));
		themes.push({
			settingsId: t.settingsId,
			extensionId: t.extensionId,
			version: t.version,
			resolved: applied === t.settingsId,
			returned: applied === undefined ? null : applied,
			error,
			kindAfter: kindName(vscode.window.activeColorTheme.kind)
		});
	}

	report.resolved = themes.filter(t => t.resolved).length;
	report.unresolved = themes.filter(t => !t.resolved).length;

	await fsp.writeFile(outPath, JSON.stringify(report, null, '\t'), 'utf8');
	await vscode.commands.executeCommand('workbench.action.quit');
}

module.exports = { run };
