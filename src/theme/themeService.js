'use strict';

const vscode = require('vscode');
const { trace } = require('../debug/logger');

/**
 * Reading installed themes, and the one call that actually paints a window.
 */

/** Every theme contributed by an installed extension. */
function listAllThemes() {
	const out = [];
	for (const ext of vscode.extensions.all) {
		const themes = ext.packageJSON?.contributes?.themes;
		if (!Array.isArray(themes)) {
			continue;
		}
		for (const t of themes) {
			out.push({
				// settingsId is `theme.id || theme.label` — see colorThemeData.ts:715.
				settingsId: t.id || t.label,
				label: t.label,
				extensionId: ext.id,
				publisher: ext.packageJSON.publisher,
				name: ext.packageJSON.name,
				version: ext.packageJSON.version
			});
		}
	}
	return out;
}

/** Map a theme settingsId back to the extension that contributes it. */
function resolveTheme(settingsId) {
	return listAllThemes().find(t => t.settingsId === settingsId) || null;
}

/**
 * Apply a theme to the current window only, writing nothing to settings.
 *
 * `workbench.action.previewColorTheme` routes to setColorTheme(theme, 'preview'),
 * which paints the window and returns before the settings write. See .spec/SPEC.md §2.
 *
 * @returns {Promise<boolean>} true when the workbench confirms the theme was applied
 */
async function applyTheme(settingsId) {
	const target = resolveTheme(settingsId);
	if (!target) {
		trace(`no installed extension contributes theme "${settingsId}"`);
		return false;
	}
	let applied;
	try {
		applied = await vscode.commands.executeCommand(
			'workbench.action.previewColorTheme',
			{ publisher: target.publisher, name: target.name, version: target.version },
			target.settingsId
		);
	} catch (err) {
		trace(`previewColorTheme threw for "${settingsId}": ${err && err.message}`);
		return false;
	}
	if (applied === target.settingsId) {
		return true;
	}
	trace(`previewColorTheme did not apply "${settingsId}" (returned ${JSON.stringify(applied)}) — ` +
		'likely not built-in and not resolvable from the gallery; see .spec/SPEC.md C1');
	return false;
}

module.exports = { listAllThemes, resolveTheme, applyTheme };
