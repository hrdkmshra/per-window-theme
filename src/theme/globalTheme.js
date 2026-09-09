'use strict';

/**
 * Working out which theme the workbench would show on its own.
 *
 * Needed because "fall back to the global theme" is not the same as "do nothing":
 * if this window is already displaying a theme we previewed earlier, we have to put
 * the global one back. The API never exposes the current theme's id (only its kind),
 * so we resolve it from settings the same way the workbench does in
 * ThemeConfiguration.getColorThemeSettingId().
 *
 * The settings reader is injected so this is testable on plain node; `vscode` is
 * required lazily, only when the default reader is actually used.
 */

const Kind = {
	Light: 1,
	Dark: 2,
	HighContrast: 3,
	HighContrastLight: 4
};

function vscodeSettingsReader() {
	// Lazy, so requiring this module outside the extension host is safe.
	const vscode = require('vscode');
	const wb = vscode.workspace.getConfiguration();
	return key => wb.get(key);
}

/**
 * @param {number|undefined} kind the theme kind the workbench painted before we
 *   touched it. Picks the right `preferred*` setting when VS Code follows the OS.
 * @param {(key: string) => any} [get] settings reader, injected in tests
 * @returns {string|undefined} theme settingsId, or undefined if unset
 */
function resolveGlobalThemeId(kind, get) {
	const read = get || vscodeSettingsReader();
	const isHighContrast = kind === Kind.HighContrast || kind === Kind.HighContrastLight;

	if (read('window.autoDetectHighContrast') && isHighContrast) {
		return kind === Kind.HighContrastLight
			? read('workbench.preferredHighContrastLightColorTheme')
			: read('workbench.preferredHighContrastColorTheme');
	}
	if (read('window.autoDetectColorScheme')) {
		return kind === Kind.Light
			? read('workbench.preferredLightColorTheme')
			: read('workbench.preferredDarkColorTheme');
	}
	return read('workbench.colorTheme');
}

module.exports = { resolveGlobalThemeId, Kind };
