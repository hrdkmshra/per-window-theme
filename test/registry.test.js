'use strict';

/**
 * Headless tests for the slot registry (SPEC.md §5, tests T7/T8/T9/T10).
 * The extension host is not involved: we stub the `vscode` module before loading
 * extension.js, then drive the registry helpers directly.
 *
 * Run: node test/registry.test.js
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- stub the `vscode` module -------------------------------------------------

let stubConfig = { staleMs: 20000, heartbeatMs: 5000, themes: ['A', 'B'], enabled: true };

const vscodeStub = {
	workspace: {
		getConfiguration: () => ({
			get: (key, fallback) => (key in stubConfig ? stubConfig[key] : fallback)
		})
	},
	env: { sessionId: 'stub-session' },
	extensions: { all: [] },
	window: {},
	commands: {},
	StatusBarAlignment: { Right: 2 }
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return realLoad(request, parent, isMain);
};

const { __test: R } = require('../extension.js');

// --- harness ------------------------------------------------------------------

const channel = { appendLine: () => {} };
let tmpDir;
let registryPath;
let failures = 0;

async function test(name, fn) {
	tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwt-test-'));
	registryPath = path.join(tmpDir, 'windows.json');
	stubConfig = { staleMs: 20000, heartbeatMs: 5000, themes: ['A', 'B'], enabled: true };
	try {
		await fn();
		console.log(`PASS  ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL  ${name}\n      ${err.message}`);
	} finally {
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
}

/** Claim a slot as a given session id, as an independent "window" would. */
async function claimAs(sid) {
	R.init(registryPath, sid, channel);
	const s = await R.claimSlot();
	R.setSlot(s);
	return s;
}

async function claims() {
	R.init(registryPath, 'reader', channel);
	return R.readRegistry();
}

// --- tests --------------------------------------------------------------------

(async () => {
	await test('missing registry file reads as empty', async () => {
		R.init(registryPath, 'w1', channel);
		assert.deepStrictEqual(await R.readRegistry(), []);
	});

	await test('lowestFreeSlot fills the first gap', () => {
		assert.strictEqual(R.lowestFreeSlot([]), 0);
		assert.strictEqual(R.lowestFreeSlot([{ slot: 0 }]), 1);
		assert.strictEqual(R.lowestFreeSlot([{ slot: 1 }]), 0);
		assert.strictEqual(R.lowestFreeSlot([{ slot: 0 }, { slot: 1 }, { slot: 3 }]), 2);
	});

	await test('two windows get distinct slots (T1)', async () => {
		assert.strictEqual(await claimAs('w1'), 0);
		assert.strictEqual(await claimAs('w2'), 1);
		assert.strictEqual((await claims()).length, 2);
	});

	await test('third window wraps onto the theme list (T10)', async () => {
		await claimAs('w1');
		await claimAs('w2');
		assert.strictEqual(await claimAs('w3'), 2);
		assert.strictEqual(R.themeForSlot(2), 'A', 'slot 2 should wrap to themes[0]');
		assert.strictEqual(R.themeForSlot(3), 'B');
	});

	await test('closing a window frees its slot for reuse (T7)', async () => {
		await claimAs('w1');
		await claimAs('w2');
		R.init(registryPath, 'w1', channel);
		await R.releaseSlot();
		assert.strictEqual(await claimAs('w3'), 0, 'w3 should take the slot w1 released');
	});

	await test('stale claims are reclaimed without cleanup (T8)', async () => {
		const old = Date.now() - 60000;
		R.init(registryPath, 'writer', channel);
		await R.writeRegistry([{ sid: 'crashed', slot: 0, ts: old }]);
		assert.strictEqual(await claimAs('w-new'), 0, 'a dead claim must not hold slot 0');
		const after = await claims();
		assert.ok(!after.some(c => c.sid === 'crashed'), 'stale claim should be pruned on write');
	});

	await test('a live claim is not stolen', async () => {
		R.init(registryPath, 'writer', channel);
		await R.writeRegistry([{ sid: 'alive', slot: 0, ts: Date.now() }]);
		assert.strictEqual(await claimAs('w-new'), 1);
	});

	await test('heartbeat keeps a claim alive past the stale window', async () => {
		stubConfig.staleMs = 5000;
		await claimAs('w1');
		const before = (await claims()).find(c => c.sid === 'w1').ts;
		await new Promise(r => setTimeout(r, 30));
		R.init(registryPath, 'w1', channel);
		R.setSlot(0);
		await R.heartbeat();
		const after = (await claims()).find(c => c.sid === 'w1').ts;
		assert.ok(after > before, 'heartbeat should advance the timestamp');
	});

	await test('simultaneous claim collision settles to distinct slots (T9)', async () => {
		// Both windows read an empty registry before either writes, so both pick slot 0.
		R.init(registryPath, 'writer', channel);
		await R.writeRegistry([]);
		const now = Date.now();
		await R.writeRegistry([
			{ sid: 'early', slot: 0, ts: now },
			{ sid: 'late', slot: 0, ts: now + 5 }
		]);

		// The later claim must yield.
		R.init(registryPath, 'late', channel);
		R.setSlot(0);
		const resolved = await R.resolveSlotConflict();
		assert.notStrictEqual(resolved, 0, '"late" should have moved off the contested slot');

		// The earlier claim keeps its slot.
		R.init(registryPath, 'early', channel);
		R.setSlot(0);
		assert.strictEqual(await R.resolveSlotConflict(), 0, '"early" should keep slot 0');
	});

	await test('registry write is atomic and leaves no temp files', async () => {
		R.init(registryPath, 'w1', channel);
		await R.writeRegistry([{ sid: 'w1', slot: 0, ts: Date.now() }]);
		const leftovers = (await fsp.readdir(tmpDir)).filter(f => f.endsWith('.tmp'));
		assert.deepStrictEqual(leftovers, [], `temp files left behind: ${leftovers}`);
		assert.ok(JSON.parse(fs.readFileSync(registryPath, 'utf8')).claims.length === 1);
	});

	await test('corrupt registry degrades to empty instead of throwing', async () => {
		await fsp.writeFile(registryPath, '{ not json', 'utf8');
		R.init(registryPath, 'w1', channel);
		assert.deepStrictEqual(await R.readRegistry(), []);
		assert.strictEqual(await claimAs('w1'), 0);
	});

	await test('empty theme list yields no theme rather than crashing (T11)', () => {
		stubConfig.themes = [];
		assert.strictEqual(R.themeForSlot(0), null);
	});

	console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
	process.exit(failures ? 1 : 0);
})();
