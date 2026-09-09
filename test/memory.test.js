'use strict';

/**
 * Folder memory tests. FolderMemory takes any Memento-shaped store, so this runs
 * against a plain in-memory object.
 */

const assert = require('assert');

const { test, fakeStore } = require('./harness');
const { FolderMemory, MEMORY_KEY } = require('../src/memory');

const KEY_A = 'file:///repo/a';
const KEY_B = 'file:///repo/b';

module.exports = async function run() {
	await test('an empty store reports nothing remembered', () => {
		const m = new FolderMemory(fakeStore());
		assert.deepStrictEqual(m.all(), {});
		assert.strictEqual(m.size(), 0);
		assert.strictEqual(m.get(KEY_A), undefined);
	});

	await test('set then get round-trips a theme', async () => {
		const m = new FolderMemory(fakeStore());
		await m.set(KEY_A, 'Monokai');
		assert.strictEqual(m.get(KEY_A), 'Monokai');
		assert.strictEqual(m.size(), 1);
	});

	await test('set records a timestamp, for future pruning', async () => {
		const m = new FolderMemory(fakeStore());
		const before = Date.now();
		await m.set(KEY_A, 'Monokai');
		assert.ok(m.all()[KEY_A].ts >= before);
	});

	await test('set on an existing folder overwrites without touching others', async () => {
		const m = new FolderMemory(fakeStore());
		await m.set(KEY_A, 'Monokai');
		await m.set(KEY_B, 'Abyss');
		await m.set(KEY_A, 'Red');
		assert.strictEqual(m.get(KEY_A), 'Red');
		assert.strictEqual(m.get(KEY_B), 'Abyss');
		assert.strictEqual(m.size(), 2);
	});

	await test('forget removes one folder and reports whether it existed', async () => {
		const m = new FolderMemory(fakeStore());
		await m.set(KEY_A, 'Monokai');
		await m.set(KEY_B, 'Abyss');
		assert.strictEqual(await m.forget(KEY_A), true);
		assert.strictEqual(m.get(KEY_A), undefined);
		assert.strictEqual(m.get(KEY_B), 'Abyss', 'forget must not disturb other folders');
		assert.strictEqual(await m.forget(KEY_A), false, 'forgetting twice reports false');
	});

	await test('clear empties everything and returns the count cleared', async () => {
		const m = new FolderMemory(fakeStore());
		await m.set(KEY_A, 'Monokai');
		await m.set(KEY_B, 'Abyss');
		assert.strictEqual(await m.clear(), 2);
		assert.strictEqual(m.size(), 0);
		assert.deepStrictEqual(m.all(), {});
	});

	await test('clear on empty memory returns zero', async () => {
		assert.strictEqual(await new FolderMemory(fakeStore()).clear(), 0);
	});

	await test('a store holding null degrades to empty', () => {
		const m = new FolderMemory(fakeStore({ [MEMORY_KEY]: null }));
		assert.deepStrictEqual(m.all(), {});
	});

	await test('existing state is read back under a versioned key', async () => {
		const store = fakeStore();
		await new FolderMemory(store).set(KEY_A, 'Monokai');
		assert.ok(MEMORY_KEY in store._data, `expected state under ${MEMORY_KEY}`);
		assert.strictEqual(new FolderMemory(store).get(KEY_A), 'Monokai');
	});
};
