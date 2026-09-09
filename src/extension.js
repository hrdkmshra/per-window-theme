'use strict';

const vscode = require('vscode');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config/settings');
const logger = require('./debug/logger');
const commands = require('./ui/commands');
const diagnostics = require('./debug/diagnostics');
const selftest = require('./debug/selftest');
const { SlotRegistry } = require('./state/registry');
const { FolderMemory } = require('./state/memory');
const { StatusBar } = require('./ui/statusBar');
const { Controller } = require('./core/controller');
const { folderKey } = require('./state/workspaceKey');

const REGISTRY_FILE = 'windows.json';

/** @type {Controller | undefined} */
let controller;
/** @type {NodeJS.Timeout | undefined} */
let heartbeatTimer;

async function activate(context) {
	const channel = vscode.window.createOutputChannel('Per-Window Theme');
	context.subscriptions.push(channel);
	logger.init(channel);

	if (process.env.PWT_SELFTEST_OUT) {
		await selftest.run(process.env.PWT_SELFTEST_OUT);
		return;
	}

	await fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true });

	const registry = new SlotRegistry({
		filePath: path.join(context.globalStorageUri.fsPath, REGISTRY_FILE),
		sessionId: vscode.env.sessionId,
		staleMs: config.staleMs,
		trace: logger.trace
	});

	const statusBar = new StatusBar();
	context.subscriptions.push(statusBar);

	controller = new Controller({
		registry,
		memory: new FolderMemory(context.globalState),
		statusBar,
		warn: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions)
	});
	context.subscriptions.push(controller);

	// The kind the workbench painted from settings, before we override anything.
	// Needed to resolve the global theme id when following the OS color scheme.
	controller.initialKind = vscode.window.activeColorTheme.kind;

	logger.trace(`activate — session ${vscode.env.sessionId}, folder ${folderKey() || '(none)'}`);

	await controller.claimSlot();
	const decision = controller.recompute();
	logger.trace(`slot ${controller.slot} -> "${decision.theme}" (${decision.source})`);

	const failureAction = await controller.apply('activate');
	if (failureAction === 'Diagnose') {
		vscode.commands.executeCommand('perWindowTheme.diagnose');
	} else if (failureAction === 'Pick another') {
		vscode.commands.executeCommand('perWindowTheme.pick');
	}

	diagnostics.validateConfiguredThemes(controller);

	heartbeatTimer = setInterval(
		() => registry.heartbeat(controller.slot, folderKey()),
		config.heartbeatMs()
	);
	context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (config.STOMP_KEYS.some(k => e.affectsConfiguration(k))) {
				// The workbench just restored the theme from settings in every window.
				controller.scheduleReapply('global theme setting changed');
			}
			if (e.affectsConfiguration(config.SECTION)) {
				const d = controller.recompute();
				logger.trace(`config changed -> "${d.theme}" (${d.source})`);
				controller.scheduleReapply('per-window config changed', 0);
			}
		}),

		vscode.window.onDidChangeActiveColorTheme(theme => {
			// Ignore the event our own apply just produced.
			if (controller.justApplied()) {
				return;
			}
			// Not overriding this window? Then what just got painted IS the global
			// theme, so track its kind — that keeps the global reference current for
			// a later restore when VS Code follows the OS color scheme.
			if (!controller.overriding) {
				controller.initialKind = theme.kind;
			}
			controller.scheduleReapply('active color theme changed underneath us');
		}),

		// Catch a stomp that happened while this window was in the background.
		vscode.window.onDidChangeWindowState(state => {
			if (state.focused && !controller.justApplied(3000)) {
				controller.scheduleReapply('window focused', 100);
			}
		}),

		// A folder added to or removed from an empty window changes the answer.
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			controller.unpin('workspace folders changed');
		}),

		...commands.registerAll(controller)
	);
}

async function deactivate() {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
	}
	controller?.dispose();
	await controller?.registry.release();
}

module.exports = { activate, deactivate };
