# Per-Window Theme — Spec

Give each open VS Code window its own color theme, simultaneously, with **no workspace file, no
folder-scoped settings, and no fork**. Personal-use extension, plug-and-play.

Target: VS Code 1.108.x (source read from `../vscode-main`, `code-oss-dev@1.108.0`).

**Status: mechanism verified on this machine.** See §8 for measured results. Headline: the approach
works, and the one predicted blocker (private/`.vsix` themes such as Dracula Pro) is real and is
fixed by §4.

---

## 1. Why the obvious approaches don't work

| Approach | Why it fails |
| --- | --- |
| `workbench.colorTheme` in User settings | One value shared by every window. |
| `workbench.colorTheme` in Workspace/Folder settings | Works, but requires a workspace/folder per theme — explicitly rejected. |
| A new "window" config scope | Doesn't exist. `ConfigurationScope.WINDOW` means *"configurable in user or workspace settings"* — both shared. ([configurationRegistry.ts:142-145](../vscode-main/src/vs/platform/configuration/common/configurationRegistry.ts#L142-L145)) |
| `workbench.colorCustomizations` | Also a setting → also global. Dead end, do not attempt. |
| Profiles (`code --profile X`) | Genuinely per-window, but a profile carries its own settings *and* extension set, and needs a window relaunch. Kept as fallback, not the design. |

## 2. The mechanism this design uses

Theme application and theme *persistence* are separate steps in VS Code. The write is gated on the
`settingsTarget` argument — [themeConfiguration.ts:364-367](../vscode-main/src/vs/workbench/services/themes/common/themeConfiguration.ts#L364-L367):

```ts
private async writeConfiguration(key: string, value: unknown, settingsTarget: ThemeSettingTarget): Promise<void> {
	if (settingsTarget === undefined || settingsTarget === 'preview') {
		return;
	}
```

With `settingsTarget === 'preview'` the theme is fully applied to the current window — CSS custom
properties recomputed and swapped in `applyTheme` — while **nothing** is written to settings and
nothing is written to storage ([workbenchThemeService.ts:521-523](../vscode-main/src/vs/workbench/services/themes/browser/workbenchThemeService.ts#L521-L523)):

```ts
// remember theme data for a quick restore
if (newTheme.isLoaded && settingsTarget !== 'preview') {
	newTheme.toStorage(this.storageService);
}
```

Theme state lives in the workbench renderer, so it is **per-window by construction**. No shared
state to fight over. That is the whole trick.

**Extension-reachable entry point** —
[themes.contribution.ts:559](../vscode-main/src/vs/workbench/contrib/themes/browser/themes.contribution.ts#L559):

```ts
CommandsRegistry.registerCommand('workbench.action.previewColorTheme', async function (accessor, extension: { publisher, name, version }, themeSettingsId?: string) {
	let themes = findBuiltInThemes(await themeService.getColorThemes(), extension);
	if (themes.length === 0) {
		themes = await themeService.getMarketplaceColorThemes(extension.publisher, extension.name, extension.version);
	}
	for (const theme of themes) {
		if (!themeSettingsId || theme.settingsId === themeSettingsId) {
			await themeService.setColorTheme(theme, 'preview');
			return theme.settingsId;
		}
	}
	return undefined;
});
```

Registered on plain `CommandsRegistry`, so it is callable from the extension host via
`vscode.commands.executeCommand` with no allowlist. It returns the applied `settingsId` on success
and `undefined` on failure — a real success signal we can act on.

`settingsId` is `theme.id || theme.label` from the contributing extension's `package.json`
([colorThemeData.ts:715](../vscode-main/src/vs/workbench/services/themes/common/colorThemeData.ts#L715)), which is how we resolve a
user-facing theme name to command arguments.

## 3. Constraints found while reading the source

### C1 — Theme resolution has two paths, and only one is offline

`findBuiltInThemes` matches on `extensionData.extensionIsBuiltin`
([themes.contribution.ts:575](../vscode-main/src/vs/workbench/contrib/themes/browser/themes.contribution.ts#L575)). That flag traces to
`ext.description.isBuiltin` ([themeExtensionPoints.ts:200](../vscode-main/src/vs/workbench/services/themes/common/themeExtensionPoints.ts#L200)),
which is set as ([extensionsScannerService.ts:1031-1032](../vscode-main/src/vs/platform/extensionManagement/common/extensionsScannerService.ts#L1031-L1032)):

```ts
isBuiltin: extension.type === ExtensionType.System,
isUserBuiltin: extension.type === ExtensionType.User && extension.isBuiltin,
```

So:

- **Builtin themes** (shipped in the app) → resolved locally, offline, instant.
- **Everything else** → falls through to `getMarketplaceColorThemes`, which builds a gallery URL from
  `product.json`'s `extensionsGallery.resourceUrlTemplate` and downloads `package.json` + theme JSON
  ([workbenchThemeService.ts:378-389](../vscode-main/src/vs/workbench/services/themes/browser/workbenchThemeService.ts#L378-L389)). Needs network,
  and needs the extension to actually exist in the gallery.

**This bites immediately.** Installed themes on this machine:

```
dracula-theme-pro.theme-dracula-pro@1.1.0  ->  Dracula Pro | Dracula Pro (Blade) | Dracula Pro (Buffy) | ...
MermaidChart.vscode-mermaid-chart@2.7.7    ->  Mermaid Dark | Mermaid Light
```

`dracula-theme-pro` is a paid/private publisher installed from `.vsix`; it is not in the public
gallery, so the fallback will 404. **Dracula Pro is expected to fail on the default path.** The PoC
detects this rather than guessing — see §6 T3.

### C2 — `extensions.json` metadata cannot fake builtin status

Setting `metadata.isBuiltin` on a user extension only produces `isUserBuiltin`
([extensionsScannerService.ts:697](../vscode-main/src/vs/platform/extensionManagement/common/extensionsScannerService.ts#L697)), and
`themeExtensionPoints` reads `isBuiltin`, not `isUserBuiltin`. **Attempted-and-rejected — do not
retry this.**

### C3 — Driving the theme quick pick is a dead end

`InstalledThemesPicker.openQuickPick` previews on focus but there is no way to leave it with the
preview intact ([themes.contribution.ts:368-377](../vscode-main/src/vs/workbench/contrib/themes/browser/themes.contribution.ts#L368-L377)):

```ts
} else {
	selectTheme(theme.theme, true);   // Enter  -> 'auto' -> writes global settings
}
...
disposables.add(quickpick.onDidHide(() => {
	if (!isCompleted) {
		selectTheme(currentTheme, true);  // Escape -> reverts
	}
```

Accept writes globally, Escape reverts. **Attempted-and-rejected.**

### C4 — Any global theme change stomps every window's preview

[workbenchThemeService.ts:247-257](../vscode-main/src/vs/workbench/services/themes/browser/workbenchThemeService.ts#L247-L257) — a config event on
`workbench.colorTheme` (or the `preferred*` / `detect*` keys) calls `restoreColorTheme()` in **every**
window, which re-reads settings and overwrites our preview. The extension must listen and re-apply.

### C5 — Preview never survives a reload, by design

That's the point of `'preview'`. On window reload the settings theme paints first, then the extension
re-applies. Expect a brief flash. Acceptable.

### C6 — No read-back of the current theme id

The API exposes only `vscode.window.activeColorTheme.kind` (light/dark/HC), never the theme id or
name. The extension tracks its own intent and treats `previewColorTheme`'s return value as truth.

### C7 — No window identity in the API

No stable window id. Slots are assigned cooperatively; see §5.

## 4. Fallback if C1 blocks the themes actually wanted

`--builtin-extensions-dir <path>` is a real CLI flag
([argv.ts:111](../vscode-main/src/vs/platform/environment/node/argv.ts#L111),
[environmentService.ts:112-114](../vscode-main/src/vs/platform/environment/common/environmentService.ts#L112-L114)). Point it at a writable
directory containing symlinks to every real builtin extension **plus** Dracula Pro. Dracula Pro then
scans as `ExtensionType.System`, `isBuiltin` is true, and `findBuiltInThemes` matches it offline —
with no edit to the app bundle and no code signature breakage.

Cost: a launch alias, and the symlink farm must be refreshed after a VS Code update.

**T3 showed the gallery path failing for Dracula Pro, so this is required, and it is verified
working** — see §7. Implemented as `./builtin-farm.sh`.

Rejected alternative: copying the theme into `Visual Studio Code.app/Contents/Resources/app/extensions/`.
Same effect, but it edits the signed app bundle and is wiped by updates.

## 5. Design

Plain JavaScript, no build step, no bundler — the extension folder is symlinked straight into
`~/.vscode/extensions/` so iteration is edit + reload window. Shell scripts live in `scripts/`, the
extension in `src/` as one module per concern (see README "Layout").

The modules that hold the logic — `decide.js`, `registry.js`, `memory.js` — take their dependencies as
arguments and never `require('vscode')`. That is what lets the whole test suite run on plain node with
no editor and no stubbing.

```
activate()
  ├── sessionId = vscode.env.sessionId                    (unique per window session)
  ├── claimSlot()   -> integer slot, 0-based, lowest free
  ├── theme = cfg('themes')[slot % themes.length]
  ├── applyTheme(theme)
  ├── heartbeat every cfg('heartbeatMs')                  keeps the claim alive
  ├── onDidChangeConfiguration
  │     ├── workbench.colorTheme / preferred* / detect*  -> debounced re-apply   (C4)
  │     └── perWindowTheme.themes                        -> recompute + re-apply
  ├── onDidChangeActiveColorTheme -> debounced re-apply, loop-guarded            (C4)
  ├── status bar item: "slot N · <theme>"                 (makes 2-window testing visible)
  └── deactivate: stop heartbeat, release claim
```

**Slot assignment (C7).** Windows cooperate through one JSON file in the extension's
`globalStorageUri` (shared across windows, private to the extension):

```json
{ "claims": [ { "sid": "<sessionId>", "slot": 0, "ts": 1757400000000 } ] }
```

- On activate: read, drop claims older than `staleMs`, take the lowest unused slot, append own claim,
  write atomically (temp file + `rename`).
- Heartbeat refreshes `ts` and prunes stale claims, so a crashed window's slot is reclaimed after
  `staleMs` with no cleanup step.
- Two windows opening at the same instant can pick the same slot. After claiming, wait a random
  100–400 ms, re-read, and if another live claim holds the same slot, the one with the later `ts`
  (tie-break: lexicographically greater `sid`) re-picks. Deterministic, no lock file.

**Theme decision.** One pure function, `decide()`, so the rule is testable and the reason is
reportable in the UI. First match wins:

1. **Window pin** — an explicit pick or cycle in this window. Session-scoped; dies with the window.
2. **Folder memory** — `folderKey()` → theme, held in `globalState` under `folderThemes.v1`.
   Deliberately not workspace settings: no `.vscode/settings.json` is created, so nothing can be
   committed into a repo by accident. Key is the `.code-workspace` URI when there is one, else the
   first workspace folder URI, else `null` for an empty window.
3. **Unmapped** — `slot` strategy walks the theme list by window order; `hash` strategy takes
   `sha1(folderKey) % list.length`, so a folder is stable across windows and machines with no setup.

Clearing is a first-class operation: per folder (`forgetFolder`) or all of it (`clearMemory`, behind a
modal confirm).

**Config**

| Setting | Default | Meaning |
| --- | --- | --- |
| `perWindowTheme.themes` | `["Dark Modern", "Light Modern"]` | Ordered theme `settingsId`s; slot N gets entry N, wrapping. Defaults are builtin so the PoC works offline out of the box. |
| `perWindowTheme.enabled` | `true` | Kill switch. |
| `perWindowTheme.heartbeatMs` | `5000` | Claim refresh interval. |
| `perWindowTheme.staleMs` | `20000` | Claim expiry. Must be a few × heartbeat. |

**Commands**

| Command | Does |
| --- | --- |
| `perWindowTheme.cycle` | Next theme in the list, this window only. |
| `perWindowTheme.pick` | Quick pick over configured themes, apply to this window only. |
| `perWindowTheme.reapply` | Force re-apply (manual C4 recovery). |
| `perWindowTheme.status` | Show slot, theme, resolution path, and the full claim registry. |
| `perWindowTheme.diagnose` | Try every installed theme via `previewColorTheme`, report which resolve. Answers C1 empirically. |

`activationEvents: ["*"]` — earliest possible, to shrink the C5 flash.

## 6. Test plan

All manual; this is a UI feature with no seam worth unit-testing at PoC stage.

| # | Test | Method | Pass |
| --- | --- | --- | --- |
| T1 | Two windows, two themes, at once | Open window A, then window B (no folder in either) | A and B show different themes from the list; both persist while idle |
| T2 | No settings pollution | `git diff` on `~/Library/Application Support/Code/User/settings.json` before/after | `workbench.colorTheme` unchanged, file untouched |
| T3 | **C1 verdict** | `perWindowTheme.diagnose` in one window | Reports per-theme pass/fail. Confirms builtin themes pass; records whether `Dracula Pro` resolves via gallery. Drives the §4 decision |
| T4 | Offline behaviour | Wi-Fi off, reload window | Builtin themes still apply; non-builtin fail loudly, not silently |
| T5 | Global theme change stomp (C4) | With A and B open, change theme normally via `Ctrl+K Ctrl+T` in A | Both windows return to their assigned per-window themes within ~1 s |
| T6 | Reload (C5) | `Developer: Reload Window` in B | B returns to its own theme; brief flash acceptable; slot unchanged |
| T7 | Slot reuse | Close A, open a new window C | C takes slot 0, i.e. A's old theme; no slot leak |
| T8 | Crash recovery | `kill -9` a window's ext-host, wait > `staleMs`, open new window | New window gets the freed slot |
| T9 | Simultaneous open race | Open two windows as close together as possible, ×5 | Never the same slot after settle; verified via `perWindowTheme.status` |
| T10 | Third window wraps | Open a 3rd window with a 2-entry list | Slot 2 → `themes[0]`, no crash |
| T11 | Disable cleanly | Set `perWindowTheme.enabled: false`, reload | Windows fall back to the normal global theme, no errors |

Recorded before running: T1–T2 and T5–T11 are expected to pass. T3 is the open question, and T4 for
non-builtin themes is expected to fail by design (C1) — that failure is the trigger for §4.

## 7. Results

Run via `./selftest.sh` — a throwaway VS Code with isolated `--user-data-dir` and
`--extensions-dir`, which probes every contributed theme through the real command and writes a JSON
report. VS Code 1.108.0, macOS.

**Automated, passing:**

- `workbench.action.previewColorTheme` is present and callable from the extension host.
- **T3 / C1 verdict:** 19 of 26 contributed themes resolve. All 19 built-in themes pass. All 7
  Dracula Pro variants fail — `dracula-theme-pro` is a private publisher, so the gallery fallback has
  nothing to fetch. Exactly as predicted in C1.
- Theme genuinely changes in-window: observed `activeColorTheme.kind` cycling through `Dark`,
  `Light`, `HighContrast`, `HighContrastLight` as themes were applied.
- **T2 pass:** `settings.json` byte-identical before and after applying 26 themes. The preview path
  leaks no write.
- **§4 fallback works:** re-run with `BUILTIN_FARM=1` (97 built-in symlinks + Dracula Pro handed to
  `--builtin-extensions-dir`) → **26 of 26 resolve**, including all 7 Dracula Pro variants, offline,
  with no gallery access and no edit to the app bundle. `./builtin-farm.sh` makes this permanent.
- Registry logic: 12/12 in `test/registry.test.js` (`node test/registry.test.js`), covering T7–T11 —
  slot reuse, stale reclaim after a crash, simultaneous-open collision, wrap-around, atomic writes,
  and corrupt-file recovery.

**Found while testing, now fixed:** the extension was scanned but never activated in the first
self-test run. Cause was Workspace Trust — a folder opened in a fresh `--user-data-dir` is untrusted,
and a restricted window does not activate extensions. Fixed by declaring
`capabilities.untrustedWorkspaces.supported` (correct anyway: this extension never executes workspace
content) and by having the self-test open an empty window with `--disable-workspace-trust`.

**Still needs eyes** — these are two-window UI behaviours no headless harness can judge:
T1 (two windows visibly differ), T5 (recovery after a normal `Ctrl+K Ctrl+T`), T6 (reload flash).
Procedure in README.md.

## 8. Known limits (accepted, personal use)

- `workbench.action.previewColorTheme` is an internal command, not `vscode.d.ts` API. No stability
  contract; a VS Code update can rename or remove it. Mitigation: the command's return value is
  checked, so breakage surfaces as a visible warning instead of silence.
- Theme flash on reload (C5).
- Non-builtin themes need network unless §4 is adopted (C1).
- Settings Sync will never carry per-window assignment; the theme list syncs, the slots don't.
