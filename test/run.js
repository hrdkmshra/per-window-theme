'use strict';

/**
 * Runs every headless suite. No VS Code, no build step: node test/run.js
 */

const { summary } = require('./harness');

const suites = [
	['registry', require('./registry.test')],
	['decide', require('./decide.test')],
	['memory', require('./memory.test')]
];

(async () => {
	for (const [name, run] of suites) {
		console.log(`\n--- ${name} ---`);
		await run();
	}
	process.exit(summary() ? 1 : 0);
})();
