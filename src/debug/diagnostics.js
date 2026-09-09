'use strict';

const vscode = require('vscode');
const config = require('../config/settings');
const logger = require('./logger');
const { trace } = logger;
const { listAllThemes } = require('../theme/themeService');
const { folderKey } = require('../state/workspaceKey');

/**
 * Troubleshooting surfaces: what this window decided, what the workbench can
 * actually resolve, and whether the configured theme ids are real.
 */

/** Dump this window's state and every live window's slot claim. */
async function status(ctrl) {
	const claims = ctrl.registry.live(await ctrl.registry.read());
	logger.show();
	trace('--- status ---');
	trace(`theme         : ${ctrl.theme}`);
	trace(`reason        : ${ctrl.source}`);
	trace(`applied ok    : ${ctrl.lastOk}`);
	trace(`slot          : ${ctrl.slot}`);
	trace(`folder        : ${folderKey() || '(none)'}`);
	trace(`window pin    : ${ctrl.pin || '(none)'}`);
	trace(`configured    : ${JSON.stringify(config.themeList())}`);
	trace(`strategy      : ${config.unmappedStrategy()}`);
	trace(`remembered    : ${ctrl.memory.size()} folder(s)`);
	trace(`registry      : ${ctrl.registry.filePath}`);
	trace(`live windows  : ${JSON.stringify(claims)}`);
	trace('--------------');
}

/**
 * Answers .spec/SPEC.md C1 empirically: try every installed theme through the real
 * command and report which ones the workbench can actually resolve.
 * Restores this window's intended theme afterwards.
 */
async function diagnose(ctrl) {
	const all = listAllThemes();
	logger.show();
	trace(`--- diagnose: ${all.length} contributed themes ---`);
	const pass = [];
	const fail = [];
	for (const t of all) {
		let applied;
		try {
			applied = await vscode.commands.executeCommand(
				'workbench.action.previewColorTheme',
				{ publisher: t.publisher, name: t.name, version: t.version },
				t.settingsId
			);
		} catch (err) {
			applied = `threw: ${err && err.message}`;
		}
		const ok = applied === t.settingsId;
		(ok ? pass : fail).push(t);
		trace(`${ok ? 'PASS' : 'FAIL'}  ${t.settingsId}  <-  ${t.extensionId}@${t.version}`);
	}
	trace(`--- diagnose done: ${pass.length} pass, ${fail.length} fail ---`);
	if (fail.length) {
		trace('FAIL means previewColorTheme could not resolve the theme: not built-in, and not');
		trace('downloadable from the gallery. Fix: launch VS Code with --builtin-extensions-dir');
		trace('pointing at a symlink farm that includes these extensions (scripts/builtin-farm.sh).');
	}
	await ctrl.apply('diagnose cleanup');
	vscode.window.showInformationMessage(
		`Per-Window Theme diagnose: ${pass.length} resolvable, ${fail.length} not. See the output channel.`);
}

/** List every installed theme id, so a typo in settings is easy to fix. */
function dumpInstalledIds() {
	logger.show();
	trace('--- installed theme ids ---');
	for (const t of listAllThemes()) {
		trace(`${t.settingsId.padEnd(30)} ${t.extensionId}`);
	}
	trace('---------------------------');
}

/** Warn once if the configured list names themes that are not installed. */
function validateConfiguredThemes(ctrl) {
	const missing = ctrl.missingConfiguredThemes();
	if (!missing.length) {
		return;
	}
	trace(`configured themes not installed: ${missing.join(', ')}`);
	vscode.window.showWarningMessage(
		`Per-Window Theme: ${missing.length} configured theme${missing.length === 1 ? '' : 's'} not installed (${missing.join(', ')}).`,
		'Show installed ids'
	).then(choice => {
		if (choice === 'Show installed ids') {
			dumpInstalledIds();
		}
	});
}

module.exports = { status, diagnose, dumpInstalledIds, validateConfiguredThemes };
