'use strict';

/**
 * Runs every headless suite. No VS Code, no build step: node test/run.js
 */

const { summary } = require('./harness');

/** @type {[string, () => Promise<void>][]} */
const suites = [
	['registry', require('./registry.test')],
	['decide', require('./decide.test')],
	['memory', require('./memory.test')],
	['globalTheme', require('./globalTheme.test')]
];

(async () => {
	for (const [name, run] of suites) {
		console.log(`\n--- ${name} ---`);
		await run();
	}
	process.exit(summary() ? 1 : 0);
})();
