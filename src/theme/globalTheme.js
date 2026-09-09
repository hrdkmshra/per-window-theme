'use strict';

const vscode = require('vscode');

/**
 * Working out which theme the workbench would show on its own.
 *
 * Needed because "fall back to the global theme" is not the same as "do nothing":
 * if this window is already displaying a theme we previewed earlier, we have to put
 * the global one back. The API never exposes the current theme's id (only its kind),
 * so we resolve it from settings the same way the workbench does in
 * ThemeConfiguration.getColorThemeSettingId().
 */

const Kind = {
	Light: 1,
	Dark: 2,
	HighContrast: 3,
	HighContrastLight: 4
};

/**
 * @param {number} kind the theme kind the workbench painted before we touched it,
 *   captured at activation. Used to pick the right `preferred*` setting when VS Code
 *   is following the OS color scheme.
 * @returns {string|undefined} theme settingsId, or undefined if unset
 */
function resolveGlobalThemeId(kind) {
	const wb = vscode.workspace.getConfiguration();
	const isHighContrast = kind === Kind.HighContrast || kind === Kind.HighContrastLight;

	if (wb.get('window.autoDetectHighContrast') && isHighContrast) {
		return kind === Kind.HighContrastLight
			? wb.get('workbench.preferredHighContrastLightColorTheme')
			: wb.get('workbench.preferredHighContrastColorTheme');
	}
	if (wb.get('window.autoDetectColorScheme')) {
		return kind === Kind.Light
			? wb.get('workbench.preferredLightColorTheme')
			: wb.get('workbench.preferredDarkColorTheme');
	}
	return wb.get('workbench.colorTheme');
}

module.exports = { resolveGlobalThemeId, Kind };
