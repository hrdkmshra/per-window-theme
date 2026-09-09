'use strict';

/**
 * Slot registry tests (SPEC.md §5, cases T1/T7/T8/T9).
 * SlotRegistry takes its dependencies as arguments, so no `vscode` stub is needed.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { test } = require('./harness');
const { SlotRegistry } = require('../src/registry');

const STALE = 20000;

/** A registry as one window would see it. */
function windowFor(dir, sid, staleMs = STALE) {
	return new SlotRegistry({
		filePath: path.join(dir, 'windows.json'),
		sessionId: sid,
		staleMs: () => staleMs,
		jitter: () => 0
	});
}

/** Claim a slot as an independent window would. */
async function claimAs(dir, sid) {
	return windowFor(dir, sid).claim();
}

module.exports = async function run() {
	await test('missing registry file reads as empty', async dir => {
		assert.deepStrictEqual(await windowFor(dir, 'w1').read(), []);
	});

	await test('lowestFreeSlot fills the first gap', () => {
		assert.strictEqual(SlotRegistry.lowestFreeSlot([]), 0);
		assert.strictEqual(SlotRegistry.lowestFreeSlot([{ slot: 0 }]), 1);
		assert.strictEqual(SlotRegistry.lowestFreeSlot([{ slot: 1 }]), 0);
		assert.strictEqual(SlotRegistry.lowestFreeSlot([{ slot: 0 }, { slot: 1 }, { slot: 3 }]), 2);
	});

	await test('two windows get distinct slots (T1)', async dir => {
		assert.strictEqual(await claimAs(dir, 'w1'), 0);
		assert.strictEqual(await claimAs(dir, 'w2'), 1);
		assert.strictEqual((await windowFor(dir, 'r').read()).length, 2);
	});

	await test('a third window keeps counting up (T10)', async dir => {
		await claimAs(dir, 'w1');
		await claimAs(dir, 'w2');
		assert.strictEqual(await claimAs(dir, 'w3'), 2);
	});

	await test('closing a window frees its slot for reuse (T7)', async dir => {
		await claimAs(dir, 'w1');
		await claimAs(dir, 'w2');
		await windowFor(dir, 'w1').release();
		assert.strictEqual(await claimAs(dir, 'w3'), 0, 'w3 should take the slot w1 released');
	});

	await test('stale claims are reclaimed without cleanup (T8)', async dir => {
		const w = windowFor(dir, 'writer');
		await w.write([{ sid: 'crashed', slot: 0, ts: Date.now() - 60000 }]);
		assert.strictEqual(await claimAs(dir, 'w-new'), 0, 'a dead claim must not hold slot 0');
		const after = await w.read();
		assert.ok(!after.some(c => c.sid === 'crashed'), 'stale claim should be pruned on write');
	});

	await test('a live claim is not stolen', async dir => {
		await windowFor(dir, 'writer').write([{ sid: 'alive', slot: 0, ts: Date.now() }]);
		assert.strictEqual(await claimAs(dir, 'w-new'), 1);
	});

	await test('heartbeat keeps a claim alive past the stale window', async dir => {
		const w = windowFor(dir, 'w1', 5000);
		await w.claim();
		const before = (await w.read()).find(c => c.sid === 'w1').ts;
		await new Promise(r => setTimeout(r, 30));
		await w.heartbeat(0, 'file:///repo/a');
		const claim = (await w.read()).find(c => c.sid === 'w1');
		assert.ok(claim.ts > before, 'heartbeat should advance the timestamp');
		assert.strictEqual(claim.folder, 'file:///repo/a', 'heartbeat should record the folder');
	});

	await test('simultaneous claim collision settles to distinct slots (T9)', async dir => {
		// Both windows read an empty registry before either wrote, so both picked slot 0.
		const now = Date.now();
		await windowFor(dir, 'writer').write([
			{ sid: 'early', slot: 0, ts: now },
			{ sid: 'late', slot: 0, ts: now + 5 }
		]);
		assert.notStrictEqual(await windowFor(dir, 'late').resolveConflict(), 0,
			'"late" should have moved off the contested slot');
		assert.strictEqual(await windowFor(dir, 'early').resolveConflict(), 0,
			'"early" should keep slot 0');
	});

	await test('a window whose claim vanished re-claims instead of throwing', async dir => {
		await windowFor(dir, 'writer').write([{ sid: 'someone-else', slot: 0, ts: Date.now() }]);
		assert.strictEqual(await windowFor(dir, 'ghost').resolveConflict(), 1);
	});

	await test('registry write is atomic and leaves no temp files', async dir => {
		const w = windowFor(dir, 'w1');
		await w.write([{ sid: 'w1', slot: 0, ts: Date.now() }]);
		const leftovers = (await fsp.readdir(dir)).filter(f => f.endsWith('.tmp'));
		assert.deepStrictEqual(leftovers, [], `temp files left behind: ${leftovers}`);
		assert.strictEqual(JSON.parse(fs.readFileSync(w.filePath, 'utf8')).claims.length, 1);
	});

	await test('corrupt registry degrades to empty instead of throwing', async dir => {
		await fsp.writeFile(path.join(dir, 'windows.json'), '{ not json', 'utf8');
		assert.deepStrictEqual(await windowFor(dir, 'w1').read(), []);
		assert.strictEqual(await claimAs(dir, 'w1'), 0);
	});
};
