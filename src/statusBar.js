'use strict';

const vscode = require('vscode');
const config = require('./config');
const { folderKey, folderLabel } = require('./workspaceKey');

/**
 * Status bar entry: what this window is showing, and why.
 */
class StatusBar {
	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'perWindowTheme.pick';
	}

	/**
	 * @param {{theme: string|null, source: string, slot: number|null, ok: boolean}} state
	 */
	render({ theme, source, slot, ok }) {
		if (!config.showStatusBar() || !config.isEnabled() || !theme) {
			this.item.hide();
			return;
		}
		this.item.text = `$(symbol-color) ${theme}${ok === false ? ' $(warning)' : ''}`;
		this.item.tooltip = new vscode.MarkdownString([
			'**Per-Window Theme**',
			'',
			`Theme: \`${theme}\`${ok === false ? ' — **could not be applied**' : ''}`,
			`Reason: ${source}`,
			`Window slot: ${slot === null ? '—' : slot}`,
			`Folder: ${folderLabel(folderKey())}`,
			'',
			'_Click to pick a theme for this window._'
		].join('\n'));
		this.item.show();
	}

	hide() {
		this.item.hide();
	}

	dispose() {
		this.item.dispose();
	}
}

module.exports = { StatusBar };
