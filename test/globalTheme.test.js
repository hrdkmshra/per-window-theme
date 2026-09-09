'use strict';

/**
 * Resolving "the theme the workbench would show on its own", which is what the
 * `global` fallback hands a window back to.
 */

const assert = require('assert');

const { test } = require('./harness');
const { resolveGlobalThemeId, Kind } = require('../src/theme/globalTheme');

/** Settings reader over a plain object. */
const reader = settings => key => settings[key];

const BASE = {
	'workbench.colorTheme': 'Dark Modern',
	'workbench.preferredDarkColorTheme': 'Abyss',
	'workbench.preferredLightColorTheme': 'Quiet Light',
	'workbench.preferredHighContrastColorTheme': 'Default High Contrast',
	'workbench.preferredHighContrastLightColorTheme': 'Default High Contrast Light',
	'window.autoDetectColorScheme': false,
	'window.autoDetectHighContrast': false
};

module.exports = async function run() {
	await test('plain case reads workbench.colorTheme', () => {
		assert.strictEqual(resolveGlobalThemeId(Kind.Dark, reader(BASE)), 'Dark Modern');
	});

	await test('kind is ignored when auto-detect is off', () => {
		for (const kind of [Kind.Light, Kind.Dark, Kind.HighContrast, Kind.HighContrastLight]) {
			assert.strictEqual(resolveGlobalThemeId(kind, reader(BASE)), 'Dark Modern');
		}
	});

	await test('following the OS color scheme reads the preferred dark theme', () => {
		const s = { ...BASE, 'window.autoDetectColorScheme': true };
		assert.strictEqual(resolveGlobalThemeId(Kind.Dark, reader(s)), 'Abyss');
	});

	await test('following the OS color scheme reads the preferred light theme', () => {
		const s = { ...BASE, 'window.autoDetectColorScheme': true };
		assert.strictEqual(resolveGlobalThemeId(Kind.Light, reader(s)), 'Quiet Light');
	});

	await test('high contrast wins over the color scheme when both are enabled', () => {
		const s = { ...BASE, 'window.autoDetectColorScheme': true, 'window.autoDetectHighContrast': true };
		assert.strictEqual(resolveGlobalThemeId(Kind.HighContrast, reader(s)), 'Default High Contrast');
		assert.strictEqual(resolveGlobalThemeId(Kind.HighContrastLight, reader(s)),
			'Default High Contrast Light');
	});

	await test('high contrast detection is ignored for a non-HC kind', () => {
		const s = { ...BASE, 'window.autoDetectHighContrast': true };
		assert.strictEqual(resolveGlobalThemeId(Kind.Dark, reader(s)), 'Dark Modern');
	});

	await test('an unset global theme resolves to undefined rather than throwing', () => {
		assert.strictEqual(resolveGlobalThemeId(Kind.Dark, reader({})), undefined);
	});

	await test('an unknown kind falls back to the dark preference under auto-detect', () => {
		const s = { ...BASE, 'window.autoDetectColorScheme': true };
		assert.strictEqual(resolveGlobalThemeId(undefined, reader(s)), 'Abyss');
	});
};
