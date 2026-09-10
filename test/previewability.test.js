'use strict';

/**
 * Deciding whether a theme is worth previewing, and what to say when it is not.
 */

const assert = require('assert');

const { test } = require('./harness');
const {
	isUnderDirectory, isBuiltinExtension, shouldSkipPreview, previewHint
} = require('../src/theme/previewability');

const USER_DIR = '/Users/someone/.vscode/extensions';
const USER_THEME = `${USER_DIR}/dracula-theme-pro.theme-dracula-pro-1.1.0`;
const APP_THEME = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-defaults';
const FARM_THEME = '/Users/someone/.per-window-theme/builtins/dracula-theme-pro.theme-dracula-pro-1.1.0';

module.exports = async function run() {
	await test('a path inside the directory is recognised', () => {
		assert.strictEqual(isUnderDirectory(USER_THEME, USER_DIR), true);
	});

	await test('a path outside the directory is not', () => {
		assert.strictEqual(isUnderDirectory(APP_THEME, USER_DIR), false);
	});

	await test('the directory itself does not count as inside itself', () => {
		assert.strictEqual(isUnderDirectory(USER_DIR, USER_DIR), false);
	});

	await test('missing paths are handled rather than throwing', () => {
		assert.strictEqual(isUnderDirectory('', USER_DIR), false);
		assert.strictEqual(isUnderDirectory(USER_THEME, ''), false);
	});

	await test('a sibling directory with a shared prefix is not inside', () => {
		// Naive string prefix matching would get this wrong.
		assert.strictEqual(isUnderDirectory('/Users/someone/.vscode/extensions-backup/x', USER_DIR), false);
	});

	await test('app-shipped themes count as built-in', () => {
		assert.strictEqual(isBuiltinExtension(APP_THEME, USER_DIR), true);
	});

	await test('a theme registered through the built-in farm counts as built-in', () => {
		// This is the whole point of the farm: it makes a paid .vsix resolvable.
		assert.strictEqual(isBuiltinExtension(FARM_THEME, USER_DIR), true);
	});

	await test('a user-installed theme does not count as built-in', () => {
		assert.strictEqual(isBuiltinExtension(USER_THEME, USER_DIR), false);
	});

	await test('only themes already known to fail are skipped', () => {
		const known = new Set(['Dracula Pro']);
		assert.strictEqual(shouldSkipPreview('Dracula Pro', known), true);
		assert.strictEqual(shouldSkipPreview('Monokai', known), false);
	});

	await test('user-installed themes are not skipped as a class', () => {
		// Public marketplace themes do resolve through the gallery; skipping them all
		// would remove previews that work.
		assert.strictEqual(shouldSkipPreview('Some Marketplace Theme', new Set()), false);
	});

	await test('nothing is skipped when no failures are known', () => {
		assert.strictEqual(shouldSkipPreview('Dracula Pro', undefined), false);
	});

	await test('the current theme is labelled as such', () => {
		const hint = previewHint({
			settingsId: 'Monokai', extensionPath: APP_THEME, userExtensionsDir: USER_DIR,
			currentTheme: 'Monokai'
		});
		assert.strictEqual(hint, 'current in this window');
	});

	await test('a failed user-installed theme points at the built-in farm', () => {
		const hint = previewHint({
			settingsId: 'Dracula Pro', extensionPath: USER_THEME, userExtensionsDir: USER_DIR,
			knownUnavailable: new Set(['Dracula Pro'])
		});
		assert.ok(hint, 'a failed theme must be explained');
		assert.match(hint, /builtin-extensions-dir/);
	});

	await test('a failed built-in theme gets a different explanation', () => {
		// The farm would not help here, so it must not be suggested.
		const hint = previewHint({
			settingsId: 'Broken Builtin', extensionPath: APP_THEME, userExtensionsDir: USER_DIR,
			knownUnavailable: new Set(['Broken Builtin'])
		});
		assert.strictEqual(hint, 'cannot be applied in this window');
	});

	await test('a failure outranks the current-theme label', () => {
		const hint = previewHint({
			settingsId: 'Dracula Pro', extensionPath: USER_THEME, userExtensionsDir: USER_DIR,
			currentTheme: 'Dracula Pro', knownUnavailable: new Set(['Dracula Pro'])
		});
		assert.ok(hint, 'a failed theme must be explained');
		assert.match(hint, /not previewable/);
	});

	await test('an untried theme gets no hint at all', () => {
		const hint = previewHint({
			settingsId: 'Abyss', extensionPath: APP_THEME, userExtensionsDir: USER_DIR,
			currentTheme: 'Monokai', knownUnavailable: new Set()
		});
		assert.strictEqual(hint, undefined);
	});
};
