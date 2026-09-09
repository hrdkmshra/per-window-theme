'use strict';

const vscode = require('vscode');
const config = require('./config');
const logger = require('./logger');
const { trace } = logger;
const { listAllThemes } = require('./themes');
const { folderKey, folderLabel } = require('./workspaceKey');

/**
 * Command implementations. Each takes the controller it acts on, so nothing here
 * holds module-level state.
 */

/** Quick pick over configured themes first, then everything else installed. */
function themePickItems(currentTheme) {
	const configured = config.themeList();
	const rest = listAllThemes().map(t => t.settingsId).filter(id => !configured.includes(id)).sort();
	/** @type {vscode.QuickPickItem[]} */
	const items = [];
	const entry = id => ({ label: id, description: id === currentTheme ? 'current in this window' : undefined });
	if (configured.length) {
		items.push({ label: 'Configured', kind: vscode.QuickPickItemKind.Separator });
		items.push(...configured.map(entry));
	}
	if (rest.length) {
		items.push({ label: 'All installed themes', kind: vscode.QuickPickItemKind.Separator });
		items.push(...rest.map(entry));
	}
	return items;
}

async function pick(ctrl) {
	const picked = await vscode.window.showQuickPick(themePickItems(ctrl.theme), {
		placeHolder: 'Theme for this window only',
		matchOnDescription: true
	});
	if (!picked) {
		return;
	}
	await ctrl.pinTheme(picked.label);

	// Offer to make it stick to this directory.
	const key = folderKey();
	if (key && config.rememberFolders() && ctrl.memory.get(key) !== picked.label) {
		const choice = await vscode.window.showInformationMessage(
			`Always use "${picked.label}" for ${folderLabel(key)}?`,
			'Remember',
			'Just this window'
		);
		if (choice === 'Remember') {
			await ctrl.memory.set(key, picked.label);
			trace(`remembered "${picked.label}" for ${key}`);
			// Folder memory now supplies the same answer, so the window pin is redundant.
			await ctrl.unpin('remembered from pick');
		}
	}
}

async function cycle(ctrl) {
	const list = config.themeList();
	if (list.length < 2) {
		vscode.window.showInformationMessage(
			`Per-Window Theme: add more entries to ${config.SECTION}.themes to cycle.`);
		return;
	}
	const next = list[(list.indexOf(ctrl.theme) + 1) % list.length];
	await ctrl.pinTheme(next, 'this window (cycled)');
}

async function rememberForFolder(ctrl) {
	const key = folderKey();
	if (!key) {
		vscode.window.showInformationMessage(
			'Per-Window Theme: this window has no folder open, so there is nothing to remember.');
		return;
	}
	const picked = await vscode.window.showQuickPick(themePickItems(ctrl.theme), {
		placeHolder: `Theme to always use for ${folderLabel(key)}`
	});
	if (!picked) {
		return;
	}
	await ctrl.memory.set(key, picked.label);
	trace(`remembered "${picked.label}" for ${key}`);
	await ctrl.unpin('remember-for-folder command');
	vscode.window.showInformationMessage(
		`Per-Window Theme: ${folderLabel(key)} will now use "${picked.label}".`);
}

async function forgetFolder(ctrl) {
	const key = folderKey();
	if (!key) {
		vscode.window.showInformationMessage('Per-Window Theme: this window has no folder open.');
		return;
	}
	const had = await ctrl.memory.forget(key);
	await ctrl.unpin('forget-folder command');
	vscode.window.showInformationMessage(had
		? `Per-Window Theme: forgot the theme for ${folderLabel(key)}.`
		: `Per-Window Theme: nothing was remembered for ${folderLabel(key)}.`);
}

async function clearMemory(ctrl) {
	const count = ctrl.memory.size();
	if (!count) {
		vscode.window.showInformationMessage('Per-Window Theme: no remembered folders to clear.');
		return;
	}
	const choice = await vscode.window.showWarningMessage(
		`Clear remembered themes for ${count} folder${count === 1 ? '' : 's'}?`,
		{ modal: true, detail: 'Windows fall back to slot rotation. This cannot be undone.' },
		'Clear'
	);
	if (choice !== 'Clear') {
		return;
	}
	await ctrl.memory.clear();
	await ctrl.unpin('clear-memory command');
	trace(`cleared ${count} remembered folder(s)`);
	vscode.window.showInformationMessage(
		`Per-Window Theme: cleared ${count} remembered folder${count === 1 ? '' : 's'}.`);
}

function showMemory(ctrl) {
	const map = ctrl.memory.all();
	const keys = Object.keys(map).sort();
	logger.show();
	trace(`--- remembered folders (${keys.length}) ---`);
	for (const k of keys) {
		trace(`${String(map[k].theme).padEnd(30)} ${k}`);
	}
	if (!keys.length) {
		trace('(none) — use "Remember Theme For This Folder"');
	}
	trace('------------------------------------');
}

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
 * Answers SPEC.md C1 empirically: try every installed theme through the real
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
		if (choice !== 'Show installed ids') {
			return;
		}
		logger.show();
		trace('--- installed theme ids ---');
		for (const t of listAllThemes()) {
			trace(`${t.settingsId.padEnd(30)} ${t.extensionId}`);
		}
		trace('---------------------------');
	});
}

/** Wire every command to the controller. @returns {vscode.Disposable[]} */
function registerAll(ctrl) {
	const map = {
		'perWindowTheme.pick': () => pick(ctrl),
		'perWindowTheme.cycle': () => cycle(ctrl),
		'perWindowTheme.rememberForFolder': () => rememberForFolder(ctrl),
		'perWindowTheme.forgetFolder': () => forgetFolder(ctrl),
		'perWindowTheme.clearMemory': () => clearMemory(ctrl),
		'perWindowTheme.showMemory': () => showMemory(ctrl),
		'perWindowTheme.reapply': () => ctrl.apply('reapply command'),
		'perWindowTheme.status': () => status(ctrl),
		'perWindowTheme.diagnose': () => diagnose(ctrl)
	};
	return Object.entries(map).map(([id, fn]) => vscode.commands.registerCommand(id, fn));
}

module.exports = { registerAll, validateConfiguredThemes, themePickItems };
