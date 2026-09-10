'use strict';

const path = require('path');

/**
 * Whether a theme is worth attempting to preview, and what to tell the user when it
 * turns out not to be.
 *
 * Background (see .spec/SPEC.md C1): `previewColorTheme` resolves a theme locally only
 * when its extension is built-in. Anything else falls through to a gallery download —
 * fine for a public marketplace theme, but slow, and a hard failure for a private or
 * paid `.vsix` such as Dracula Pro. So a theme is tried once; if it fails it is
 * remembered, and from then on the picker skips it instantly and says why.
 *
 * Only failures are skipped, never "user-installed" as a class: plenty of
 * user-installed themes do resolve through the gallery, and skipping those would
 * remove working previews.
 *
 * No `vscode` import: the caller passes the paths, which keeps this unit-testable.
 */

/** @param {string} target @param {string} directory */
function isUnderDirectory(target, directory) {
	if (!target || !directory) {
		return false;
	}
	const rel = path.relative(directory, target);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A theme extension counts as built-in when it does not live in the user extensions
 * directory — which covers both the ones shipped inside the app and any registered
 * through `--builtin-extensions-dir`.
 *
 * @param {string} extensionPath the theme extension's install location
 * @param {string} userExtensionsDir where user-installed extensions live
 */
function isBuiltinExtension(extensionPath, userExtensionsDir) {
	return !isUnderDirectory(extensionPath, userExtensionsDir);
}

/** Attempt a preview unless this theme is already known to fail. */
function shouldSkipPreview(settingsId, knownUnavailable) {
	return Boolean(knownUnavailable && knownUnavailable.has(settingsId));
}

/**
 * Description to show beside a theme in the picker.
 *
 * @param {object} input
 * @param {string} input.settingsId
 * @param {string} input.extensionPath
 * @param {string} input.userExtensionsDir
 * @param {string|null} [input.currentTheme] theme this window is showing
 * @param {Set<string>} [input.knownUnavailable] ids that already failed to apply
 * @returns {string|undefined}
 */
function previewHint({ settingsId, extensionPath, userExtensionsDir, currentTheme, knownUnavailable }) {
	if (shouldSkipPreview(settingsId, knownUnavailable)) {
		// Tailored to the cause, so the fix is obvious rather than a shrug.
		return isBuiltinExtension(extensionPath, userExtensionsDir)
			? 'cannot be applied in this window'
			: 'not previewable — launch with --builtin-extensions-dir';
	}
	if (settingsId === currentTheme) {
		return 'current in this window';
	}
	return undefined;
}

module.exports = { isUnderDirectory, isBuiltinExtension, shouldSkipPreview, previewHint };
