'use strict';

const vscode = require('vscode');
const config = require('../config/settings');
const { folderKey, folderLabel } = require('../state/workspaceKey');

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
		if (!config.showStatusBar() || !config.isEnabled()) {
			this.item.hide();
			return;
		}
		// No per-window theme: still show an entry, so the picker stays one click away.
		this.item.text = theme
			? `$(symbol-color) ${theme}${ok === false ? ' $(warning)' : ''}`
			: '$(symbol-color) global';
		this.item.tooltip = new vscode.MarkdownString([
			'**Per-Window Theme**',
			'',
			theme
				? `Theme: \`${theme}\`${ok === false ? ' — **could not be applied**' : ''}`
				: 'Theme: your normal global theme',
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

module.exports.StatusBar = StatusBar;
