# Per-Window Theme — Reference

Each open VS Code window gets its own color theme, at the same time. No workspace file, no
folder-scoped settings, no fork of VS Code.

Problem statement and install steps are in [../README.md](../README.md). This file is the full reference.

Status: working PoC. Behaviour verified on VS Code 1.136.2 / macOS; the mechanism was derived from the 1.108.0 source checkout. Design and evidence in [../.spec/SPEC.md](../.spec/SPEC.md).

## How it works, in one paragraph

VS Code applies a theme and *saves* a theme in two separate steps. `setColorTheme(theme, 'preview')`
paints the window and deliberately writes nothing to settings. Theme state lives in the window's
renderer, so a preview is per-window by construction. The internal command
`workbench.action.previewColorTheme` reaches that path and is callable from an extension. This
extension assigns each window a slot number, then previews slot N's theme into it.

## Install

See [../README.md](../README.md#install-locally). Short version: `./scripts/install.sh`, then quit VS
Code fully and reopen. Private/`.vsix` themes additionally need `./scripts/builtin-farm.sh`.

## How a window picks its theme

Three rules, first match wins:

| Priority | Rule | Set by |
| --- | --- | --- |
| 1 | **This window, explicitly** | `Pick Theme (This Window)` or `Cycle Theme`. Lasts until the window is closed |
| 2 | **Remembered for this folder** | `Remember Theme For This Folder` — that directory then opens with that theme every time, in any window |
| 3 | **Fallback**, per `unmappedStrategy` | `global` (default) leaves your normal theme in place; `slot` rotates by window order; `hash` derives from the folder path |

Because tiers 1 and 2 beat the fallback, changing your global theme never overrides a window that has
its own: windows with no setup follow the new global theme, and windows with a pick or a remembered
folder re-apply theirs within about a second.

`global` is a true handback, not just "skip". If a window is already showing a theme we applied and
then loses its reason to — you clear the folder mapping, say — the extension actively restores the
global theme. Since the API exposes only the current theme's *kind* and never its id, that id is
resolved from settings the same way the workbench does, honouring `window.autoDetectColorScheme` and
`window.autoDetectHighContrast` ([src/theme/globalTheme.js](../src/theme/globalTheme.js)).

Folder memory is stored in the extension's own state, **never** in `.vscode/settings.json`, so
nothing lands in your repos and nothing gets committed by accident.

Change `perWindowTheme.unmappedStrategy` from `global` to `slot` for automatic per-window rotation, or
to `hash` to derive a stable theme from the folder path — the same repo always looks the same, with no
picking at all.

## Commands

| Command | Does |
| --- | --- |
| `Pick Theme (This Window)` | Quick pick — configured themes first, then everything installed. Offers to remember it for the folder |
| `Cycle Theme (This Window)` | Next theme in the list, this window only |
| `Remember Theme For This Folder` | Pin a theme to the open directory, for all future windows |
| `Forget Theme For This Folder` | Drop that folder's mapping |
| `Show Remembered Folders` | List every folder → theme mapping |
| `Clear All Remembered Folders` | Wipe the memory (asks first) |
| `Re-apply Theme` | Force re-apply |
| `Show Status` | Theme, why it was chosen, slot, folder, and the live window registry |
| `Diagnose Theme Resolution` | Probe every installed theme, report what resolves |

All are prefixed `Per-Window Theme:` in the command palette.

The status bar shows the current theme; click it to pick another. Its tooltip explains *why* this
window has this theme (explicit pick / remembered folder / slot), and shows a warning icon if the
theme could not be applied.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `perWindowTheme.enabled` | `true` | Kill switch |
| `perWindowTheme.themes` | `["Dark Modern", "Light Modern"]` | Theme ids offered by the picker, and used in order by the `slot` / `hash` strategies |
| `perWindowTheme.rememberFolders` | `true` | Remember a theme per directory |
| `perWindowTheme.unmappedStrategy` | `"global"` | `global` = keep your normal theme; `slot` = by window order; `hash` = stable per folder path |
| `perWindowTheme.showStatusBar` | `true` | Show the theme in the status bar |
| `perWindowTheme.notifyOnFailure` | `true` | Warn instead of failing silently |
| `perWindowTheme.heartbeatMs` | `5000` | How often a window refreshes its slot claim |
| `perWindowTheme.staleMs` | `20000` | When an unrefreshed claim is treated as dead |

## Quality-of-life behaviour

- Re-applies your theme within ~1s when a normal `Cmd+K Cmd+T` overwrites it in every window.
- Also re-checks when a window regains focus, catching a stomp that happened in the background.
- Warns at startup if `themes` names something not installed, and can dump the valid ids.
- Recomputes when you add or remove a folder in an empty window.
- Failure surfaces as a warning with `Diagnose` / `Pick another`, never a silent no-op.

## Tests

```bash
npm run typecheck            # type-check the JSDoc annotations (no build output)
npm test                     # 46 headless tests: slots, decision tiers, folder memory, global resolution
./scripts/scenario.sh        # end-to-end in a real window: opt in, survive a global change, hand back
./scripts/selftest.sh        # throwaway VS Code, probes every theme, writes a JSON report
BUILTIN_FARM=1 ./scripts/selftest.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
./scripts/demo.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0   # two live windows
```

### Why plain JavaScript, not TypeScript

Deliberate: the extension folder is symlinked straight into `~/.vscode/extensions`, so there is no
compile step between editing a file and reloading a window, and `bootstrap.sh` can clone and run with
no `npm install` and no build on the user's machine.

Type safety is kept without giving that up: every module is JSDoc-annotated and `npm run typecheck`
runs `tsc --noEmit` with `checkJs` **and `strictNullChecks`** over `src/` and `test/`, currently
clean. TypeScript is a dev-only dependency; nothing at runtime needs it.

`noImplicitAny` is deliberately off. Turning it on adds 63 "parameter implicitly has an any type"
errors — annotation paperwork with no defect among them — whereas `strictNullChecks` found a real
pattern worth fixing. Measured, not assumed.

Note that classes are exported as `module.exports.Thing = Thing` rather than
`module.exports = { Thing }` — the latter is seen as `export=`, which stops
`import('./mod').Thing` resolving in JSDoc types.

`selftest.sh` and `demo.sh` use isolated `--user-data-dir` / `--extensions-dir`, so they cannot touch
your real editor, settings, or extensions. No build step and no dependencies: the tests run on plain
node because the logic modules take their dependencies as arguments instead of importing `vscode`.

Three things need human eyes, since they're two-window UI behaviour:

1. **T1** — open two windows with no folder. They should show different themes, both stable.
2. **T5** — change the theme normally (`Ctrl+K Ctrl+T`) in one window. Within about a second, both
   windows should snap back to their own assigned themes.
3. **T6** — `Developer: Reload Window`. The window returns to its own theme after a brief flash of
   the global theme.

## Layout

```
src/
  extension.js            entry point: activate/deactivate and event wiring
  core/
    controller.js         this window's theme state: decide, apply, keep it applied
    decide.js             the three-tier decision, pure and vscode-free
  state/
    registry.js           cross-window slot claims (heartbeat file)
    memory.js             folder -> theme, over any Memento-shaped store
    workspaceKey.js       how a window identifies its folder
  theme/
    themeService.js       installed themes + the previewColorTheme call
    globalTheme.js        resolves the theme the workbench would show on its own
  ui/
    statusBar.js          status item and tooltip
    commands.js           user-facing command implementations
  config/
    settings.js           settings accessors, stomp key list
  debug/
    logger.js             output channel
    diagnostics.js        status dump, theme-resolution probe, config validation
    selftest.js           headless probe used by scripts/selftest.sh
scripts/                  install.sh, builtin-farm.sh, selftest.sh, demo.sh
test/                     run.js + one suite per module (32 cases)
.spec/SPEC.md             design derivation, constraints, dead ends, measurements
docs/REFERENCE.md         this file
```

## Limits

- `workbench.action.previewColorTheme` is an internal command, not public API. A VS Code update can
  rename or remove it. The extension checks the command's return value, so a break shows up as a
  visible warning rather than silence.
- Theme flash on window reload — preview state intentionally never persists.
- Private/paid themes need the built-in farm above.
- Settings Sync carries the theme list, never the per-window slot assignment.
