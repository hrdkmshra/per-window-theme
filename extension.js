'use strict';

const vscode = require('vscode');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CFG = 'perWindowTheme';
const REGISTRY_FILE = 'windows.json';
const MEMORY_KEY = 'folderThemes.v1';

/**
 * Config keys whose change means the workbench re-read the theme from settings and
 * therefore clobbered our preview. See SPEC.md C4.
 */
const STOMP_KEYS = [
	'workbench.colorTheme',
	'workbench.preferredDarkColorTheme',
	'workbench.preferredLightColorTheme',
	'workbench.preferredHighContrastColorTheme',
	'workbench.preferredHighContrastLightColorTheme',
	'window.autoDetectColorScheme',
	'window.autoDetectHighContrast'
];

/** @type {vscode.OutputChannel} */
let log;
/** @type {vscode.StatusBarItem} */
let statusItem;
/** @type {vscode.ExtensionContext} */
let ctx;
let registryPath;
let sessionId;
/** @type {NodeJS.Timeout | undefined} */
let heartbeatTimer;
/** @type {NodeJS.Timeout | undefined} */
let reapplyTimer;

/** Slot this window owns, or null before it is claimed. */
let slot = null;
/** Theme settingsId this window intends to display. */
let intendedTheme = null;
/** Where that decision came from, for the status tooltip. */
let themeSource = 'unset';
/** Theme chosen explicitly for this window; beats folder memory and slot rotation. */
let windowPin = null;
/** Timestamp of our last successful apply, used to ignore our own change events. */
let lastAppliedAt = 0;

function cfg() {
	return vscode.workspace.getConfiguration(CFG);
}

function trace(msg) {
	const stamp = new Date().toISOString().slice(11, 23);
	log.appendLine(`[${stamp}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Slot registry — a shared JSON file with heartbeat-expiring claims (SPEC.md §5)
// ---------------------------------------------------------------------------

async function readRegistry() {
	try {
		const raw = await fsp.readFile(registryPath, 'utf8');
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed.claims) ? parsed.claims : [];
	} catch (err) {
		if (err && err.code !== 'ENOENT') {
			trace(`registry read failed, starting empty: ${err.message}`);
		}
		return [];
	}
}

async function writeRegistry(claims) {
	// Temp file + rename, so a window reading mid-write never sees a partial file.
	const tmp = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify({ claims }, null, '\t'), 'utf8');
	await fsp.rename(tmp, registryPath);
}

function live(claims, now) {
	const stale = cfg().get('staleMs', 20000);
	return claims.filter(c => c && typeof c.slot === 'number' && now - c.ts < stale);
}

function lowestFreeSlot(claims) {
	const used = new Set(claims.map(c => c.slot));
	let n = 0;
	while (used.has(n)) {
		n++;
	}
	return n;
}

async function claimSlot() {
	const now = Date.now();
	const others = live(await readRegistry(), now).filter(c => c.sid !== sessionId);
	const mine = { sid: sessionId, slot: lowestFreeSlot(others), ts: now };
	await writeRegistry([...others, mine]);
	return mine.slot;
}

/**
 * Two windows opening at the same moment can pick the same slot: both read the
 * registry before either wrote. Settle it after a jittered delay — the claim with
 * the later timestamp yields, sessionId breaks exact ties.
 */
async function resolveSlotConflict() {
	await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 300)));
	const now = Date.now();
	const claims = live(await readRegistry(), now);
	const mine = claims.find(c => c.sid === sessionId);
	if (!mine) {
		trace('own claim vanished (stale or overwritten), re-claiming');
		return claimSlot();
	}
	const rival = claims.find(c =>
		c.sid !== sessionId &&
		c.slot === mine.slot &&
		(c.ts < mine.ts || (c.ts === mine.ts && c.sid < sessionId))
	);
	if (!rival) {
		return mine.slot;
	}
	trace(`slot ${mine.slot} collided with ${rival.sid}, yielding`);
	return claimSlot();
}

async function heartbeat() {
	try {
		const now = Date.now();
		const claims = live(await readRegistry(), now).filter(c => c.sid !== sessionId);
		await writeRegistry([...claims, { sid: sessionId, slot, ts: now, folder: folderKey() }]);
	} catch (err) {
		trace(`heartbeat failed: ${err.message}`);
	}
}

async function releaseSlot() {
	try {
		const claims = await readRegistry();
		await writeRegistry(claims.filter(c => c.sid !== sessionId));
	} catch (err) {
		trace(`release failed: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------
// Folder memory — "this directory always gets that theme"
//
// Stored in the extension's globalState, deliberately NOT in workspace settings,
// so no .vscode/settings.json is created and nothing lands in your repos.
// ---------------------------------------------------------------------------

/** Stable key for what this window has open, or null for an empty window. */
function folderKey() {
	const wf = vscode.workspace.workspaceFile;
	if (wf && wf.scheme !== 'untitled') {
		return wf.toString();
	}
	const folders = vscode.workspace.workspaceFolders;
	if (folders && folders.length) {
		// Multi-root without a .code-workspace file: key on the first folder.
		return folders[0].uri.toString();
	}
	return null;
}

function folderLabel(key) {
	if (!key) {
		return '(no folder)';
	}
	try {
		return path.basename(vscode.Uri.parse(key).fsPath) || key;
	} catch {
		return key;
	}
}

function readMemory() {
	return ctx.globalState.get(MEMORY_KEY, {});
}

async function writeMemory(map) {
	await ctx.globalState.update(MEMORY_KEY, map);
}

async function rememberFolder(key, theme) {
	const map = { ...readMemory() };
	map[key] = { theme, ts: Date.now() };
	await writeMemory(map);
	trace(`remembered "${theme}" for ${key}`);
}

async function forgetFolder(key) {
	const map = { ...readMemory() };
	const had = key in map;
	delete map[key];
	await writeMemory(map);
	return had;
}

/**
 * Deterministic theme for a path when nothing is remembered: the same folder always
 * lands on the same theme, without anyone having to configure it.
 */
function hashPick(key, list) {
	if (!list.length) {
		return null;
	}
	const digest = crypto.createHash('sha1').update(key).digest();
	return list[digest.readUInt32BE(0) % list.length];
}

/**
 * Single place that decides what this window should show, and why.
 * Pure, so it is unit-testable: see test/registry.test.js.
 */
function decide({ pin, memory, key, list, slotNumber, strategy }) {
	if (pin) {
		return { theme: pin, source: 'this window (explicit pick)' };
	}
	if (key && memory[key] && memory[key].theme) {
		return { theme: memory[key].theme, source: `remembered for ${folderLabel(key)}` };
	}
	if (!list.length) {
		return { theme: null, source: 'no themes configured' };
	}
	if (key && strategy === 'hash') {
		return { theme: hashPick(key, list), source: `derived from folder name (${folderLabel(key)})` };
	}
	return { theme: list[slotNumber % list.length], source: `window slot ${slotNumber}` };
}

function recompute() {
	const d = decide({
		pin: windowPin,
		memory: cfg().get('rememberFolders', true) ? readMemory() : {},
		key: folderKey(),
		list: themeList(),
		slotNumber: slot === null ? 0 : slot,
		strategy: cfg().get('unmappedStrategy', 'slot')
	});
	intendedTheme = d.theme;
	themeSource = d.source;
	return d;
}

// ---------------------------------------------------------------------------
// Theme resolution and application (SPEC.md §2)
// ---------------------------------------------------------------------------

/**
 * Map a theme settingsId back to the extension that contributes it.
 * settingsId is `theme.id || theme.label` — see colorThemeData.ts:715.
 */
function resolveTheme(settingsId) {
	for (const ext of vscode.extensions.all) {
		const themes = ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.themes;
		if (!Array.isArray(themes)) {
			continue;
		}
		for (const t of themes) {
			if ((t.id || t.label) === settingsId) {
				return {
					publisher: ext.packageJSON.publisher,
					name: ext.packageJSON.name,
					version: ext.packageJSON.version,
					settingsId,
					extensionId: ext.id
				};
			}
		}
	}
	return null;
}

function listAllThemes() {
	const out = [];
	for (const ext of vscode.extensions.all) {
		const themes = ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.themes;
		if (!Array.isArray(themes)) {
			continue;
		}
		for (const t of themes) {
			out.push({
				settingsId: t.id || t.label,
				label: t.label,
				extensionId: ext.id,
				publisher: ext.packageJSON.publisher,
				name: ext.packageJSON.name,
				version: ext.packageJSON.version
			});
		}
	}
	return out;
}

/**
 * Apply a theme to this window only, writing nothing to settings.
 * Returns true when the workbench confirms the theme was applied.
 */
async function applyTheme(settingsId) {
	const target = resolveTheme(settingsId);
	if (!target) {
		trace(`no installed extension contributes theme "${settingsId}"`);
		return false;
	}
	let applied;
	try {
		applied = await vscode.commands.executeCommand(
			'workbench.action.previewColorTheme',
			{ publisher: target.publisher, name: target.name, version: target.version },
			target.settingsId
		);
	} catch (err) {
		trace(`previewColorTheme threw for "${settingsId}": ${err && err.message}`);
		return false;
	}
	const ok = applied === target.settingsId;
	lastAppliedAt = Date.now();
	trace(ok
		? `applied "${settingsId}" (${target.extensionId}) — ${themeSource}`
		: `previewColorTheme did not apply "${settingsId}" (returned ${JSON.stringify(applied)}) — likely not built-in and not resolvable from the gallery; see SPEC.md C1`);
	return ok;
}

function themeList() {
	const list = cfg().get('themes', []);
	return Array.isArray(list) ? list.filter(t => typeof t === 'string' && t.length) : [];
}

function updateStatus(ok) {
	if (!statusItem) {
		return;
	}
	if (!cfg().get('showStatusBar', true) || !intendedTheme) {
		statusItem.hide();
		return;
	}
	statusItem.text = `$(symbol-color) ${intendedTheme}${ok === false ? ' $(warning)' : ''}`;
	statusItem.tooltip = new vscode.MarkdownString(
		[
			`**Per-Window Theme**`,
			``,
			`Theme: \`${intendedTheme}\`${ok === false ? ' — **could not be applied**' : ''}`,
			`Reason: ${themeSource}`,
			`Window slot: ${slot === null ? '—' : slot}`,
			`Folder: ${folderLabel(folderKey())}`,
			``,
			`_Click to pick a theme for this window._`
		].join('\n')
	);
	statusItem.command = 'perWindowTheme.pick';
	statusItem.show();
}

async function applyIntended(reason) {
	if (!cfg().get('enabled', true)) {
		trace(`skipped apply (${reason}): disabled`);
		statusItem.hide();
		return;
	}
	if (!intendedTheme) {
		updateStatus(true);
		return;
	}
	const ok = await applyTheme(intendedTheme);
	updateStatus(ok);
	if (!ok && cfg().get('notifyOnFailure', true)) {
		const choice = await vscode.window.showWarningMessage(
			`Per-Window Theme could not apply "${intendedTheme}" in this window.`,
			'Diagnose',
			'Pick another'
		);
		if (choice === 'Diagnose') {
			vscode.commands.executeCommand('perWindowTheme.diagnose');
		} else if (choice === 'Pick another') {
			vscode.commands.executeCommand('perWindowTheme.pick');
		}
	}
}

function scheduleReapply(reason, delay = 250) {
	if (reapplyTimer) {
		clearTimeout(reapplyTimer);
	}
	reapplyTimer = setTimeout(() => {
		reapplyTimer = undefined;
		trace(`re-applying: ${reason}`);
		applyIntended(reason);
	}, delay);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Quick pick over configured themes first, then everything else installed. */
function themePickItems() {
	const configured = themeList();
	const all = listAllThemes().map(t => t.settingsId);
	const rest = all.filter(id => !configured.includes(id)).sort();
	/** @type {vscode.QuickPickItem[]} */
	const items = [];
	if (configured.length) {
		items.push({ label: 'Configured', kind: vscode.QuickPickItemKind.Separator });
		for (const id of configured) {
			items.push({ label: id, description: id === intendedTheme ? 'current in this window' : undefined });
		}
	}
	if (rest.length) {
		items.push({ label: 'All installed themes', kind: vscode.QuickPickItemKind.Separator });
		for (const id of rest) {
			items.push({ label: id, description: id === intendedTheme ? 'current in this window' : undefined });
		}
	}
	return items;
}

async function cmdPick() {
	const picked = await vscode.window.showQuickPick(themePickItems(), {
		placeHolder: 'Theme for this window only',
		matchOnDescription: true
	});
	if (!picked) {
		return;
	}
	windowPin = picked.label;
	intendedTheme = picked.label;
	themeSource = 'this window (explicit pick)';
	await applyIntended('pick command');

	const key = folderKey();
	if (key && cfg().get('rememberFolders', true) && readMemory()[key]?.theme !== picked.label) {
		const choice = await vscode.window.showInformationMessage(
			`Always use "${picked.label}" for ${folderLabel(key)}?`,
			'Remember',
			'Just this window'
		);
		if (choice === 'Remember') {
			await rememberFolder(key, picked.label);
			windowPin = null; // folder memory now supplies the same answer
			recompute();
			updateStatus(true);
		}
	}
}

async function cmdCycle() {
	const list = themeList();
	if (list.length < 2) {
		vscode.window.showInformationMessage(`Per-Window Theme: add more entries to ${CFG}.themes to cycle.`);
		return;
	}
	const at = list.indexOf(intendedTheme);
	windowPin = list[(at + 1) % list.length];
	intendedTheme = windowPin;
	themeSource = 'this window (cycled)';
	await applyIntended('cycle command');
}

async function cmdRememberForFolder() {
	const key = folderKey();
	if (!key) {
		vscode.window.showInformationMessage('Per-Window Theme: this window has no folder open, so there is nothing to remember.');
		return;
	}
	const picked = await vscode.window.showQuickPick(themePickItems(), {
		placeHolder: `Theme to always use for ${folderLabel(key)}`
	});
	if (!picked) {
		return;
	}
	await rememberFolder(key, picked.label);
	windowPin = null;
	recompute();
	await applyIntended('remember-for-folder command');
	vscode.window.showInformationMessage(`Per-Window Theme: ${folderLabel(key)} will now use "${picked.label}".`);
}

async function cmdForgetFolder() {
	const key = folderKey();
	if (!key) {
		vscode.window.showInformationMessage('Per-Window Theme: this window has no folder open.');
		return;
	}
	const had = await forgetFolder(key);
	windowPin = null;
	recompute();
	await applyIntended('forget-folder command');
	vscode.window.showInformationMessage(had
		? `Per-Window Theme: forgot the theme for ${folderLabel(key)}.`
		: `Per-Window Theme: nothing was remembered for ${folderLabel(key)}.`);
}

async function cmdClearMemory() {
	const map = readMemory();
	const count = Object.keys(map).length;
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
	await writeMemory({});
	windowPin = null;
	recompute();
	await applyIntended('clear-memory command');
	trace(`cleared ${count} remembered folder(s)`);
	vscode.window.showInformationMessage(`Per-Window Theme: cleared ${count} remembered folder${count === 1 ? '' : 's'}.`);
}

async function cmdShowMemory() {
	const map = readMemory();
	const keys = Object.keys(map);
	log.show(true);
	trace(`--- remembered folders (${keys.length}) ---`);
	for (const k of keys.sort()) {
		trace(`${String(map[k].theme).padEnd(30)} ${k}`);
	}
	if (!keys.length) {
		trace('(none) — use "Remember Theme For This Folder"');
	}
	trace('------------------------------------');
}

async function cmdStatus() {
	const claims = live(await readRegistry(), Date.now());
	log.show(true);
	trace('--- status ---');
	trace(`theme         : ${intendedTheme}`);
	trace(`reason        : ${themeSource}`);
	trace(`slot          : ${slot}`);
	trace(`folder        : ${folderKey() || '(none)'}`);
	trace(`window pin    : ${windowPin || '(none)'}`);
	trace(`configured    : ${JSON.stringify(themeList())}`);
	trace(`strategy      : ${cfg().get('unmappedStrategy', 'slot')}`);
	trace(`remembered    : ${Object.keys(readMemory()).length} folder(s)`);
	trace(`registry      : ${registryPath}`);
	trace(`live windows  : ${JSON.stringify(claims)}`);
	trace('--------------');
}

/**
 * Answers SPEC.md C1 empirically: try every installed theme through the real
 * command and report which ones the workbench can actually resolve.
 * Restores this window's intended theme afterwards.
 */
async function cmdDiagnose() {
	const all = listAllThemes();
	log.show(true);
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
		trace('pointing at a symlink farm that includes these extensions (see builtin-farm.sh).');
	}
	await applyIntended('diagnose cleanup');
	vscode.window.showInformationMessage(
		`Per-Window Theme diagnose: ${pass.length} resolvable, ${fail.length} not. See the output channel.`
	);
}

/** Warn once if the configured list names themes that are not installed. */
function validateConfiguredThemes() {
	const installed = new Set(listAllThemes().map(t => t.settingsId));
	const missing = themeList().filter(id => !installed.has(id));
	if (!missing.length) {
		return;
	}
	trace(`configured themes not installed: ${missing.join(', ')}`);
	vscode.window.showWarningMessage(
		`Per-Window Theme: ${missing.length} configured theme${missing.length === 1 ? '' : 's'} not installed (${missing.join(', ')}).`,
		'Show installed ids'
	).then(choice => {
		if (choice === 'Show installed ids') {
			log.show(true);
			trace('--- installed theme ids ---');
			for (const t of listAllThemes()) {
				trace(`${t.settingsId.padEnd(30)} ${t.extensionId}`);
			}
			trace('---------------------------');
		}
	});
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Non-interactive verification, used by selftest.sh against a throwaway VS Code
 * instance. Only ever runs when PWT_SELFTEST_OUT is set in the environment, so it
 * cannot fire in a normal editor session. Writes a JSON report, then quits.
 */
async function runSelfTest(outPath) {
	const kindName = k => ({ 1: 'Light', 2: 'Dark', 3: 'HighContrast', 4: 'HighContrastLight' }[k] || String(k));
	const report = {
		vscodeVersion: vscode.version,
		sessionId: vscode.env.sessionId,
		commandAvailable: (await vscode.commands.getCommands(true)).includes('workbench.action.previewColorTheme'),
		startingThemeKind: kindName(vscode.window.activeColorTheme.kind),
		themes: []
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
		report.themes.push({
			settingsId: t.settingsId,
			extensionId: t.extensionId,
			version: t.version,
			resolved: applied === t.settingsId,
			returned: applied === undefined ? null : applied,
			error,
			kindAfter: kindName(vscode.window.activeColorTheme.kind)
		});
	}

	report.resolved = report.themes.filter(t => t.resolved).length;
	report.unresolved = report.themes.filter(t => !t.resolved).length;

	await fsp.writeFile(outPath, JSON.stringify(report, null, '\t'), 'utf8');
	await vscode.commands.executeCommand('workbench.action.quit');
}

async function activate(context) {
	ctx = context;
	log = vscode.window.createOutputChannel('Per-Window Theme');
	context.subscriptions.push(log);

	if (process.env.PWT_SELFTEST_OUT) {
		await runSelfTest(process.env.PWT_SELFTEST_OUT);
		return;
	}

	sessionId = vscode.env.sessionId;
	registryPath = path.join(context.globalStorageUri.fsPath, REGISTRY_FILE);
	await fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true });

	trace(`activate — session ${sessionId}, folder ${folderKey() || '(none)'}`);

	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusItem);

	slot = await claimSlot();
	slot = await resolveSlotConflict();

	const d = recompute();
	trace(`slot ${slot} -> "${d.theme}" (${d.source})`);
	await applyIntended('activate');
	validateConfiguredThemes();

	heartbeatTimer = setInterval(heartbeat, cfg().get('heartbeatMs', 5000));
	context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async e => {
			if (STOMP_KEYS.some(k => e.affectsConfiguration(k))) {
				// The workbench just restored the theme from settings in every window.
				scheduleReapply('global theme setting changed');
			}
			if (e.affectsConfiguration(CFG)) {
				recompute();
				trace(`config changed -> "${intendedTheme}" (${themeSource})`);
				scheduleReapply('per-window config changed', 0);
			}
		}),

		vscode.window.onDidChangeActiveColorTheme(() => {
			// Ignore the event our own apply just produced.
			if (Date.now() - lastAppliedAt < 1500) {
				return;
			}
			scheduleReapply('active color theme changed underneath us');
		}),

		// Catch a stomp that happened while this window was in the background.
		vscode.window.onDidChangeWindowState(state => {
			if (state.focused && Date.now() - lastAppliedAt > 3000) {
				scheduleReapply('window focused', 100);
			}
		}),

		// A folder added to or removed from an empty window changes the answer.
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			windowPin = null;
			recompute();
			scheduleReapply('workspace folders changed', 0);
		}),

		vscode.commands.registerCommand('perWindowTheme.pick', cmdPick),
		vscode.commands.registerCommand('perWindowTheme.cycle', cmdCycle),
		vscode.commands.registerCommand('perWindowTheme.rememberForFolder', cmdRememberForFolder),
		vscode.commands.registerCommand('perWindowTheme.forgetFolder', cmdForgetFolder),
		vscode.commands.registerCommand('perWindowTheme.clearMemory', cmdClearMemory),
		vscode.commands.registerCommand('perWindowTheme.showMemory', cmdShowMemory),
		vscode.commands.registerCommand('perWindowTheme.reapply', () => applyIntended('reapply command')),
		vscode.commands.registerCommand('perWindowTheme.status', cmdStatus),
		vscode.commands.registerCommand('perWindowTheme.diagnose', cmdDiagnose)
	);
}

async function deactivate() {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
	}
	if (reapplyTimer) {
		clearTimeout(reapplyTimer);
	}
	await releaseSlot();
}

module.exports = {
	activate,
	deactivate,
	// Exposed for the headless tests in test/registry.test.js.
	__test: {
		init(pathToRegistry, sid, channel) {
			registryPath = pathToRegistry;
			sessionId = sid;
			log = channel;
		},
		readRegistry,
		writeRegistry,
		live,
		lowestFreeSlot,
		claimSlot,
		resolveSlotConflict,
		heartbeat,
		releaseSlot,
		setSlot(n) { slot = n; },
		getSlot() { return slot; },
		decide,
		hashPick
	}
};
