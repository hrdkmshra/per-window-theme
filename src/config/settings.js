'use strict';

const vscode = require('vscode');

const SECTION = 'perWindowTheme';

/**
 * Config keys whose change means the workbench re-read the theme from settings and
 * therefore clobbered our preview. See .spec/SPEC.md C4.
 */
const STOMP_KEYS = [
	'workbench.colorTheme',
	'workbench.preferredDarkColorTheme',
	'workbench.preferredLightColorTheme',
	'workbench.preferredHighContrastColorTheme',
	'workbench.preferredHighContrastLightColorTheme',
	'window.autoDetectColorScheme',
	'window.autoDetectHighContrast'
];

function raw() {
	return vscode.workspace.getConfiguration(SECTION);
}

/** Configured theme ids, cleaned of blanks and non-strings. */
function themeList() {
	const list = raw().get('themes', []);
	return Array.isArray(list) ? list.filter(t => typeof t === 'string' && t.length) : [];
}

module.exports = {
	SECTION,
	STOMP_KEYS,
	raw,
	themeList,
	isEnabled: () => raw().get('enabled', true),
	rememberFolders: () => raw().get('rememberFolders', true),
	unmappedStrategy: () => raw().get('unmappedStrategy', 'global'),
	showStatusBar: () => raw().get('showStatusBar', true),
	notifyOnFailure: () => raw().get('notifyOnFailure', true),
	heartbeatMs: () => raw().get('heartbeatMs', 5000),
	staleMs: () => raw().get('staleMs', 20000)
};
