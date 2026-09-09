'use strict';

const vscode = require('vscode');
const path = require('path');

/**
 * How a window identifies "the directory I have open", for folder memory.
 */

/** Stable key for what this window has open, or null for an empty window. */
function folderKey() {
	const wf = vscode.workspace.workspaceFile;
	if (wf && wf.scheme !== 'untitled') {
		return wf.toString();
	}
	const folders = vscode.workspace.workspaceFolders;
	if (folders && folders.length) {
		// Multi-root without a .code-workspace file: key on the first folder.
		return folders[0].uri.toString();
	}
	return null;
}

/** Short human-readable name for a folder key. */
function folderLabel(key) {
	if (!key) {
		return '(no folder)';
	}
	try {
		return path.basename(vscode.Uri.parse(key).fsPath) || key;
	} catch {
		return key;
	}
}

module.exports = { folderKey, folderLabel };
