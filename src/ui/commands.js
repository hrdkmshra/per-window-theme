'use strict';

const vscode = require('vscode');
const config = require('../config/settings');
const logger = require('../debug/logger');
const { trace } = logger;
const diagnostics = require('../debug/diagnostics');
const { listAllThemes } = require('../theme/themeService');
const { folderKey, folderLabel } = require('../state/workspaceKey');

/**
 * Command implementations. Each takes the controller it acts on, so nothing here
 * holds module-level state. Troubleshooting commands live in debug/diagnostics.js.
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
		'perWindowTheme.status': () => diagnostics.status(ctrl),
		'perWindowTheme.diagnose': () => diagnostics.diagnose(ctrl)
	};
	return Object.entries(map).map(([id, fn]) => vscode.commands.registerCommand(id, fn));
}

module.exports = { registerAll, themePickItems };
