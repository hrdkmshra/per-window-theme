'use strict';

const crypto = require('crypto');

/**
 * The theme decision, deliberately free of any `vscode` import so it can be unit
 * tested directly. Everything it needs is passed in.
 */

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
 * Decide what a window should show, and why. First match wins:
 *   1. an explicit pick in this window
 *   2. a theme remembered for the open folder
 *   3. whatever `strategy` says: hand back to the global theme, rotate by window
 *      slot, or derive from the folder path
 *
 * @param {object} input
 * @param {string|null|undefined} input.pin explicit choice for this window
 * @param {Record<string, {theme?: string}>} input.memory folder key -> remembered theme
 * @param {string|null|undefined} input.key folder key for this window, null when empty
 * @param {string[]} input.list configured theme ids
 * @param {number} input.slotNumber this window's slot
 * @param {'global'|'slot'|'hash'} input.strategy what to do when nothing is set up
 *   for this window: leave the global theme alone, rotate by window order, or derive
 *   from the folder path
 * @param {string} [input.label] human-readable folder name, for the reason string
 * @returns {{theme: string|null, source: string}}
 */
function decide({ pin, memory, key, list, slotNumber, strategy, label }) {
	if (pin) {
		return { theme: pin, source: 'this window (explicit pick)' };
	}
	if (key && memory && memory[key] && memory[key].theme) {
		return { theme: memory[key].theme, source: `remembered for ${label || key}` };
	}
	if (strategy === 'global') {
		// Nothing set up for this window or its folder: the global theme owns it.
		return { theme: null, source: 'global theme (nothing set up for this window)' };
	}
	if (!list.length) {
		return { theme: null, source: 'no themes configured' };
	}
	if (key && strategy === 'hash') {
		return { theme: hashPick(key, list), source: `derived from folder name (${label || key})` };
	}
	return { theme: list[slotNumber % list.length], source: `window slot ${slotNumber}` };
}

module.exports = { decide, hashPick };
