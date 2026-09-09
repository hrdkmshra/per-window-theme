'use strict';

const config = require('../config/settings');
const { trace } = require('../debug/logger');
const { decide } = require('./decide');
const { applyTheme, listAllThemes } = require('../theme/themeService');
const { resolveGlobalThemeId } = require('../theme/globalTheme');
const { folderKey, folderLabel } = require('../state/workspaceKey');

/**
 * Owns this window's theme state: what it should show, why, and keeping it that way
 * when the workbench overwrites it.
 */
class Controller {
	/**
	 * @param {object} deps
	 * @param {import('../state/registry').SlotRegistry} deps.registry
	 * @param {import('../state/memory').FolderMemory} deps.memory
	 * @param {import('../ui/statusBar').StatusBar} deps.statusBar
	 * @param {(theme: string) => void} [deps.onApplyFailed] told when a theme could not
	 *   be applied. Reporting it, and any UI that follows, belongs to the caller.
	 */
	constructor({ registry, memory, statusBar, onApplyFailed }) {
		this.registry = registry;
		this.memory = memory;
		this.statusBar = statusBar;
		this.onApplyFailed = onApplyFailed || (() => { });

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
		/**
		 * Whether this window is currently showing a theme we applied. Lets us tell
		 * "leave the global theme alone" from "put the global theme back".
		 */
		this.overriding = false;
		/**
		 * The theme kind the workbench painted before we touched anything. Used to
		 * resolve the global theme id when VS Code follows the OS color scheme.
		 */
		this.initialKind = undefined;
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
			strategy: /** @type {'global'|'slot'|'hash'} */ (config.unmappedStrategy()),
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

	/**
	 * Apply this window's intended theme. Applying is all this does: a failure is
	 * announced through `onApplyFailed`, so nothing here knows about dialogs.
	 */
	async apply(reason) {
		if (!config.isEnabled()) {
			trace(`skipped apply (${reason}): disabled`);
			this.statusBar.hide();
			return;
		}
		if (!this.theme) {
			await this.restoreGlobal(reason);
			this.render();
			return;
		}
		this.lastOk = await applyTheme(this.theme);
		this.lastAppliedAt = Date.now();
		this.overriding = this.overriding || this.lastOk;
		trace(this.lastOk
			? `applied "${this.theme}" — ${this.source} (${reason})`
			: `failed to apply "${this.theme}" (${reason})`);
		this.render();

		if (!this.lastOk && config.notifyOnFailure()) {
			this.onApplyFailed(this.theme);
		}
	}

	/**
	 * Hand the window back to the global theme. A no-op unless we had actually
	 * overridden it, so a window with no per-window setup is never repainted.
	 */
	async restoreGlobal(reason) {
		if (!this.overriding) {
			return undefined;
		}
		const globalTheme = resolveGlobalThemeId(this.initialKind);
		if (!globalTheme) {
			trace(`nothing to restore: no global theme configured (${reason})`);
			this.overriding = false;
			return;
		}
		const ok = await applyTheme(globalTheme);
		this.lastAppliedAt = Date.now();
		this.overriding = !ok;
		trace(ok
			? `restored global theme "${globalTheme}" (${reason})`
			: `could not restore global theme "${globalTheme}" (${reason})`);
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

module.exports.Controller = Controller;
