'use strict';

const KEY = 'folderThemes.v1';

/**
 * "This directory always gets that theme."
 *
 * Backed by the extension's globalState, deliberately NOT by workspace settings, so
 * no .vscode/settings.json is created and nothing can be committed into a repo by
 * accident. Takes any Memento-shaped object, so it needs no `vscode` import.
 */
class FolderMemory {
	/** @param {{ get(key: string, fallback: any): any, update(key: string, value: any): Thenable<void> }} store */
	constructor(store) {
		this.store = store;
	}

	/** @returns {Record<string, {theme: string, ts: number}>} */
	all() {
		return this.store.get(KEY, {}) || {};
	}

	get(key) {
		const entry = this.all()[key];
		return entry ? entry.theme : undefined;
	}

	async set(key, theme) {
		await this.store.update(KEY, { ...this.all(), [key]: { theme, ts: Date.now() } });
	}

	/** @returns {Promise<boolean>} whether anything was actually removed */
	async forget(key) {
		const map = { ...this.all() };
		const had = key in map;
		delete map[key];
		await this.store.update(KEY, map);
		return had;
	}

	async clear() {
		const count = this.size();
		await this.store.update(KEY, {});
		return count;
	}

	size() {
		return Object.keys(this.all()).length;
	}
}

module.exports = { FolderMemory, MEMORY_KEY: KEY };
