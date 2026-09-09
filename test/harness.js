'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/**
 * Minimal test harness. Each test gets a fresh temp dir; failures are collected
 * rather than thrown, so one broken case does not hide the rest.
 */

const state = { failures: 0, total: 0 };

/** @param {string} name @param {(dir: string) => any} fn */
async function test(name, fn) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwt-test-'));
	state.total++;
	try {
		await fn(dir);
		console.log(`PASS  ${name}`);
	} catch (err) {
		state.failures++;
		console.log(`FAIL  ${name}\n      ${err.message}`);
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
}

function summary() {
	console.log(state.failures
		? `\n${state.failures} of ${state.total} test(s) failed`
		: `\nall ${state.total} tests passed`);
	return state.failures;
}

/** Memento-shaped in-memory store, for FolderMemory. */
function fakeStore(initial = {}) {
	const data = { ...initial };
	return {
		get: (key, fallback) => (key in data ? data[key] : fallback),
		async update(key, value) { data[key] = value; },
		_data: data
	};
}

module.exports = { test, summary, fakeStore, state };
