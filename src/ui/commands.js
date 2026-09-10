'use strict';

const vscode = require('vscode');
const config = require('../config/settings');
const logger = require('../debug/logger');
const { trace } = logger;
const diagnostics = require('../debug/diagnostics');
const { listAllThemes } = require('../theme/themeService');
const { previewHint, shouldSkipPreview } = require('../theme/previewability');
const { folderKey, folderLabel } = require('../state/workspaceKey');

/** Matches the pacing of VS Code's own theme picker. */
const PREVIEW_DEBOUNCE_MS = 200;

/**
 * Command implementations. Each takes the controller it acts on, so nothing here
 * holds module-level state. Troubleshooting commands live in debug/diagnostics.js.
 */

/**
 * Quick pick over configured themes first, then everything else installed. Entries
 * carry a hint when a theme is known not to be previewable here.
 *
 * @param {string|null} currentTheme
 * @param {string} [userExtensionsDir]
 * @param {Set<string>} [knownUnavailable]
 */
function themePickItems(currentTheme, userExtensionsDir = '', knownUnavailable = new Set()) {
	const configured = config.themeList();
	const all = listAllThemes();
	const pathOf = id => (all.find(t => t.settingsId === id) || {}).extensionPath || '';
	const rest = all.map(t => t.settingsId).filter(id => !configured.includes(id)).sort();
	/** @type {vscode.QuickPickItem[]} */
	const items = [];
	const entry = id => ({
		label: id,
		description: previewHint({
			settingsId: id,
			extensionPath: pathOf(id),
			userExtensionsDir,
			currentTheme,
			knownUnavailable
		})
	});
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


/**
 * Theme picker that previews as you move through it, the way VS Code's own theme
 * picker does, and puts the window back if you cancel.
 *
 * `showQuickPick` cannot do this: it never reports which entry is highlighted. Only
 * `createQuickPick` exposes `onDidChangeActive`, so the picker is built by hand.
 *
 * @param {any} ctrl
 * @param {string} placeHolder
 * @returns {Promise<string|undefined>} the chosen theme id, or undefined if cancelled
 */
async function pickThemeWithPreview(ctrl, placeHolder) {
	const before = ctrl.snapshot();
	const unavailable = ctrl.unavailableThemes;
	const rebuild = () => themePickItems(ctrl.theme, ctrl.userExtensionsDir, unavailable);

	const picker = vscode.window.createQuickPick();
	picker.items = rebuild();
	picker.placeholder = placeHolder;
	picker.matchOnDescription = true;

	/** @type {string|undefined} */
	let chosen;
	/** @type {NodeJS.Timeout | undefined} */
	let previewTimer;
	/** In flight, so the closing revert can wait for it rather than racing it. */
	let inFlight = Promise.resolve();

	picker.onDidChangeActive(active => {
		const item = active[0];
		if (!item || item.kind === vscode.QuickPickItemKind.Separator) {
			return;
		}
		// Debounced, and the pending preview is cancelled rather than queued — the same
		// 200ms pacing VS Code's own theme picker uses. Queueing them made a fast
		// scroll apply every theme it passed over, one after another, which is what
		// made this feel laggy.
		if (previewTimer) {
			clearTimeout(previewTimer);
		}
		if (shouldSkipPreview(item.label, unavailable)) {
			return; // already known to fail: do not stall on it again
		}
		previewTimer = setTimeout(() => {
			previewTimer = undefined;
			inFlight = ctrl.previewTheme(item.label).then(ok => {
				if (ok === false) {
					// Remember, so scrolling past it again is instant, and label it.
					unavailable.add(item.label);
					const active0 = picker.activeItems[0];
					picker.items = rebuild();
					if (active0) {
						picker.activeItems = picker.items.filter(i => i.label === active0.label);
					}
				}
			});
		}, PREVIEW_DEBOUNCE_MS);
	});

	picker.onDidAccept(() => {
		const item = picker.activeItems[0];
		if (item && item.kind !== vscode.QuickPickItemKind.Separator) {
			chosen = item.label;
		}
		picker.hide();
	});

	await new Promise(resolve => {
		picker.onDidHide(() => {
			picker.dispose();
			resolve(undefined);
		});
		picker.show();
	});

	if (previewTimer) {
		clearTimeout(previewTimer);
	}
	await inFlight;
	if (!chosen) {
		// Cancelled: undo whatever the previews painted.
		await ctrl.restoreSnapshot(before, 'theme picker cancelled');
	}
	return chosen;
}

async function pick(ctrl) {
	const picked = await pickThemeWithPreview(ctrl, 'Theme for this window only');
	if (!picked) {
		return;
	}
	await ctrl.pinTheme(picked);

	// Offer to make it stick to this directory.
	const key = folderKey();
	if (key && config.rememberFolders() && ctrl.memory.get(key) !== picked) {
		const choice = await vscode.window.showInformationMessage(
			`Always use "${picked}" for ${folderLabel(key)}?`,
			'Remember',
			'Just this window'
		);
		if (choice === 'Remember') {
			await ctrl.memory.set(key, picked);
			trace(`remembered "${picked}" for ${key}`);
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
	const picked = await pickThemeWithPreview(ctrl, `Theme to always use for ${folderLabel(key)}`);
	if (!picked) {
		return;
	}
	await ctrl.memory.set(key, picked);
	trace(`remembered "${picked}" for ${key}`);
	await ctrl.unpin('remember-for-folder command');
	vscode.window.showInformationMessage(
		`Per-Window Theme: ${folderLabel(key)} will now use "${picked}".`);
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

module.exports = { registerAll, themePickItems, pickThemeWithPreview };
