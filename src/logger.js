'use strict';

/**
 * Thin wrapper over the output channel, so every other module can just call
 * trace() without threading a channel through its signatures.
 */

/** @type {{ appendLine(line: string): void, show?(preserveFocus?: boolean): void } | null} */
let channel = null;

function init(outputChannel) {
	channel = outputChannel;
}

function trace(msg) {
	if (!channel) {
		return;
	}
	const stamp = new Date().toISOString().slice(11, 23);
	channel.appendLine(`[${stamp}] ${msg}`);
}

function show() {
	channel?.show?.(true);
}

module.exports = { init, trace, show };
