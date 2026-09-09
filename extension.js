'use strict';

const vscode = require('vscode');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const CFG = 'perWindowTheme';
const REGISTRY_FILE = 'windows.json';

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
/** @type {string} */
let registryPath;
/** @type {string} */
let sessionId;
/** @type {NodeJS.Timeout | undefined} */
let heartbeatTimer;
/** @type {NodeJS.Timeout | undefined} */
let reapplyTimer;

/** Slot this window owns, or null before it is claimed. */
let slot = null;
/** Theme settingsId this window intends to display. */
let intendedTheme = null;
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
		await writeRegistry([...claims, { sid: sessionId, slot, ts: now }]);
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
		? `applied "${settingsId}" (${target.extensionId})`
		: `previewColorTheme did not apply "${settingsId}" (returned ${JSON.stringify(applied)}) — likely not built-in and not resolvable from the gallery; see SPEC.md C1`);
	return ok;
}

function themesForSlot() {
	const list = cfg().get('themes', []);
	return Array.isArray(list) ? list.filter(t => typeof t === 'string' && t.length) : [];
}

function themeForSlot(n) {
	const list = themesForSlot();
	return list.length ? list[n % list.length] : null;
}

function updateStatus(ok) {
	if (!statusItem) {
		return;
	}
	if (slot === null || !intendedTheme) {
		statusItem.hide();
		return;
	}
	statusItem.text = `$(symbol-color) slot ${slot} · ${intendedTheme}${ok === false ? ' $(warning)' : ''}`;
	statusItem.tooltip = ok === false
		? `Per-Window Theme: could not apply "${intendedTheme}" in this window. Run "Per-Window Theme: Diagnose Theme Resolution".`
		: `Per-Window Theme — window slot ${slot}, showing "${intendedTheme}" (this window only)`;
	statusItem.command = 'perWindowTheme.status';
	statusItem.show();
}

async function applyIntended(reason) {
	if (!cfg().get('enabled', true)) {
		trace(`skipped apply (${reason}): disabled`);
		updateStatus(true);
		return;
	}
	if (!intendedTheme) {
		return;
	}
	const ok = await applyTheme(intendedTheme);
	updateStatus(ok);
	if (!ok) {
		vscode.window.showWarningMessage(
			`Per-Window Theme could not apply "${intendedTheme}" in this window.`,
			'Diagnose'
		).then(choice => {
			if (choice === 'Diagnose') {
				vscode.commands.executeCommand('perWindowTheme.diagnose');
			}
		});
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

async function cmdCycle() {
	const list = themesForSlot();
	if (list.length < 2) {
		vscode.window.showInformationMessage(`Per-Window Theme: add more entries to ${CFG}.themes to cycle.`);
		return;
	}
	const at = list.indexOf(intendedTheme);
	intendedTheme = list[(at + 1) % list.length];
	await applyIntended('cycle command');
}

async function cmdPick() {
	const list = themesForSlot();
	const items = (list.length ? list : listAllThemes().map(t => t.settingsId)).map(id => ({
		label: id,
		description: id === intendedTheme ? 'current (this window)' : undefined
	}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Apply a theme to this window only'
	});
	if (picked) {
		intendedTheme = picked.label;
		await applyIntended('pick command');
	}
}

async function cmdStatus() {
	const claims = live(await readRegistry(), Date.now());
	log.show(true);
	trace('--- status ---');
	trace(`sessionId     : ${sessionId}`);
	trace(`slot          : ${slot}`);
	trace(`intendedTheme : ${intendedTheme}`);
	trace(`configured    : ${JSON.stringify(themesForSlot())}`);
	trace(`registry      : ${registryPath}`);
	trace(`live claims   : ${JSON.stringify(claims)}`);
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
		trace('pointing at a symlink farm that includes these extensions (SPEC.md §4).');
	}
	await applyIntended('diagnose cleanup');
	vscode.window.showInformationMessage(
		`Per-Window Theme diagnose: ${pass.length} resolvable, ${fail.length} not. See the output channel.`
	);
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
	log = vscode.window.createOutputChannel('Per-Window Theme');
	context.subscriptions.push(log);

	if (process.env.PWT_SELFTEST_OUT) {
		await runSelfTest(process.env.PWT_SELFTEST_OUT);
		return;
	}

	sessionId = vscode.env.sessionId;
	registryPath = path.join(context.globalStorageUri.fsPath, REGISTRY_FILE);
	await fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true });

	trace(`activate — session ${sessionId}, registry ${registryPath}`);

	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusItem);

	slot = await claimSlot();
	slot = await resolveSlotConflict();
	intendedTheme = themeForSlot(slot);
	trace(`slot ${slot} -> theme "${intendedTheme}"`);

	await applyIntended('activate');

	const beat = cfg().get('heartbeatMs', 5000);
	heartbeatTimer = setInterval(heartbeat, beat);
	context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async e => {
			if (STOMP_KEYS.some(k => e.affectsConfiguration(k))) {
				// The workbench just restored the theme from settings in every window.
				scheduleReapply('global theme setting changed');
			}
			if (e.affectsConfiguration(`${CFG}.themes`) || e.affectsConfiguration(`${CFG}.enabled`)) {
				intendedTheme = themeForSlot(slot);
				trace(`config changed — slot ${slot} -> theme "${intendedTheme}"`);
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

		vscode.commands.registerCommand('perWindowTheme.cycle', cmdCycle),
		vscode.commands.registerCommand('perWindowTheme.pick', cmdPick),
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
	// Exposed for the headless registry tests in test/registry.test.js.
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
		themeForSlot
	}
};
