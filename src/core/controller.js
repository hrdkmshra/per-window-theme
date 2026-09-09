'use strict';

const config = require('../config/settings');
const { trace } = require('../debug/logger');
const { decide } = require('./decide');
const { applyTheme, listAllThemes } = require('../theme/themeService');
const { folderKey, folderLabel } = require('../state/workspaceKey');

/**
 * Owns this window's theme state: what it should show, why, and keeping it that way
 * when the workbench overwrites it.
 */
class Controller {
	/**
	 * @param {object} deps
	 * @param {import('./registry').SlotRegistry} deps.registry
	 * @param {import('./memory').FolderMemory} deps.memory
	 * @param {import('./statusBar').StatusBar} deps.statusBar
	 * @param {(message: string, ...actions: string[]) => Thenable<string|undefined>} deps.warn
	 */
	constructor({ registry, memory, statusBar, warn }) {
		this.registry = registry;
		this.memory = memory;
		this.statusBar = statusBar;
		this.warn = warn;

		/** Slot this window owns, or null before it is claimed. */
		this.slot = null;
		/** Theme this window intends to display. */
		this.theme = null;
		/** Where that decision came from. */
		this.source = 'unset';
		/** Explicit choice for this window; beats folder memory and slot rotation. */
		this.pin = null;
		/** Timestamp of the last successful apply, to ignore our own change events. */
		this.lastAppliedAt = 0;
		/** @type {NodeJS.Timeout | undefined} */
		this.reapplyTimer = undefined;
		/** Result of the last apply, for the status bar. */
		this.lastOk = true;
	}

	async claimSlot() {
		this.slot = await this.registry.claim();
		this.slot = await this.registry.resolveConflict();
		return this.slot;
	}

	/** Re-run the decision from current config, memory and folder. */
	recompute() {
		const key = folderKey();
		const d = decide({
			pin: this.pin,
			memory: config.rememberFolders() ? this.memory.all() : {},
			key,
			list: config.themeList(),
			slotNumber: this.slot === null ? 0 : this.slot,
			strategy: config.unmappedStrategy(),
			label: folderLabel(key)
		});
		this.theme = d.theme;
		this.source = d.source;
		return d;
	}

	/** Choose a theme for this window only, for as long as the window lives. */
	async pinTheme(theme, source = 'this window (explicit pick)') {
		this.pin = theme;
		this.theme = theme;
		this.source = source;
		await this.apply(`pin ${theme}`);
	}

	/** Drop the window pin so folder memory or slot rotation decides again. */
	async unpin(reason) {
		this.pin = null;
		this.recompute();
		await this.apply(reason);
	}

	async apply(reason) {
		if (!config.isEnabled()) {
			trace(`skipped apply (${reason}): disabled`);
			this.statusBar.hide();
			return;
		}
		if (!this.theme) {
			this.render();
			return;
		}
		this.lastOk = await applyTheme(this.theme);
		this.lastAppliedAt = Date.now();
		trace(this.lastOk
			? `applied "${this.theme}" — ${this.source} (${reason})`
			: `failed to apply "${this.theme}" (${reason})`);
		this.render();

		if (!this.lastOk && config.notifyOnFailure()) {
			const choice = await this.warn(
				`Per-Window Theme could not apply "${this.theme}" in this window.`,
				'Diagnose',
				'Pick another'
			);
			if (choice) {
				return choice;
			}
		}
		return undefined;
	}

	render() {
		this.statusBar.render({
			theme: this.theme,
			source: this.source,
			slot: this.slot,
			ok: this.lastOk
		});
	}

	/**
	 * Debounced re-apply, used when something outside us changed the theme.
	 * Ignores the change event our own apply just produced.
	 */
	scheduleReapply(reason, delay = 250) {
		if (this.reapplyTimer) {
			clearTimeout(this.reapplyTimer);
		}
		this.reapplyTimer = setTimeout(() => {
			this.reapplyTimer = undefined;
			trace(`re-applying: ${reason}`);
			this.apply(reason);
		}, delay);
	}

	justApplied(withinMs = 1500) {
		return Date.now() - this.lastAppliedAt < withinMs;
	}

	/** Theme ids in config that no installed extension provides. */
	missingConfiguredThemes() {
		const installed = new Set(listAllThemes().map(t => t.settingsId));
		return config.themeList().filter(id => !installed.has(id));
	}

	dispose() {
		if (this.reapplyTimer) {
			clearTimeout(this.reapplyTimer);
		}
	}
}

module.exports = { Controller };
