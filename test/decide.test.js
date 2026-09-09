'use strict';

/**
 * Theme decision tests: window pin > folder memory > slot rotation / folder hash.
 */

const assert = require('assert');

const { test } = require('./harness');
const { decide, hashPick } = require('../src/core/decide');

const LIST = ['Dracula Pro', 'Light Modern'];
const base = { pin: null, memory: {}, key: null, list: LIST, slotNumber: 0, strategy: 'slot' };

module.exports = async function run() {
	await test('slot rotation assigns by window order', () => {
		assert.strictEqual(decide({ ...base, slotNumber: 0 }).theme, 'Dracula Pro');
		assert.strictEqual(decide({ ...base, slotNumber: 1 }).theme, 'Light Modern');
		assert.strictEqual(decide({ ...base, slotNumber: 2 }).theme, 'Dracula Pro', 'should wrap');
		assert.strictEqual(decide({ ...base, slotNumber: 3 }).theme, 'Light Modern');
	});

	await test('folder memory beats slot rotation', () => {
		const memory = { 'file:///repo/a': { theme: 'Monokai' } };
		const d = decide({ ...base, memory, key: 'file:///repo/a', slotNumber: 1 });
		assert.strictEqual(d.theme, 'Monokai');
		assert.match(d.source, /remembered/);
	});

	await test('an explicit window pick beats folder memory', () => {
		const memory = { 'file:///repo/a': { theme: 'Monokai' } };
		const d = decide({ ...base, pin: 'Abyss', memory, key: 'file:///repo/a' });
		assert.strictEqual(d.theme, 'Abyss');
		assert.match(d.source, /this window/);
	});

	await test('an unremembered folder falls back to slot rotation', () => {
		const memory = { 'file:///repo/other': { theme: 'Monokai' } };
		assert.strictEqual(
			decide({ ...base, memory, key: 'file:///repo/a', slotNumber: 1 }).theme,
			'Light Modern');
	});

	await test('a memory entry with no theme is ignored', () => {
		const memory = { 'file:///repo/a': {} };
		assert.strictEqual(decide({ ...base, memory, key: 'file:///repo/a', slotNumber: 1 }).theme, 'Light Modern');
	});

	await test('the reason names the folder using the supplied label', () => {
		const memory = { 'file:///repo/a': { theme: 'Monokai' } };
		const d = decide({ ...base, memory, key: 'file:///repo/a', label: 'repo-a' });
		assert.strictEqual(d.source, 'remembered for repo-a');
	});

	await test('hash strategy is stable per folder and ignores window order', () => {
		const a1 = decide({ ...base, key: 'file:///repo/a', strategy: 'hash', slotNumber: 0 }).theme;
		const a2 = decide({ ...base, key: 'file:///repo/a', strategy: 'hash', slotNumber: 7 }).theme;
		assert.strictEqual(a1, a2, 'same folder must always map to the same theme');
		assert.ok(LIST.includes(a1));
	});

	await test('hash strategy spreads different folders across the list', () => {
		const seen = new Set();
		for (let i = 0; i < 40; i++) {
			seen.add(hashPick(`file:///repo/p${i}`, LIST));
		}
		assert.strictEqual(seen.size, LIST.length, `expected both themes to be used, saw ${[...seen]}`);
	});

	await test('hash strategy does not apply to an empty window', () => {
		const d = decide({ ...base, key: null, strategy: 'hash', slotNumber: 1 });
		assert.strictEqual(d.theme, 'Light Modern');
		assert.match(d.source, /slot 1/);
	});

	await test('no themes configured decides nothing (T11)', () => {
		const d = decide({ ...base, list: [] });
		assert.strictEqual(d.theme, null);
		assert.match(d.source, /no themes configured/);
	});

	await test('hashPick on an empty list returns null rather than throwing', () => {
		assert.strictEqual(hashPick('file:///repo/a', []), null);
	});
};
