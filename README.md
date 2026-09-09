# Per-Window Theme

Each open VS Code window gets its own color theme, at the same time. No workspace file, no
folder-scoped settings, no fork of VS Code.

Status: working PoC, verified on VS Code 1.108.0 / macOS. Design and evidence in [SPEC.md](SPEC.md).

## How it works, in one paragraph

VS Code applies a theme and *saves* a theme in two separate steps. `setColorTheme(theme, 'preview')`
paints the window and deliberately writes nothing to settings. Theme state lives in the window's
renderer, so a preview is per-window by construction. The internal command
`workbench.action.previewColorTheme` reaches that path and is callable from an extension. This
extension assigns each window a slot number, then previews slot N's theme into it.

## Install

```bash
./scripts/install.sh          # symlinks into ~/.vscode/extensions
```

Then fully quit VS Code (Cmd+Q) and reopen, so the extension is scanned.

Pick your themes in settings:

```jsonc
{
  "perWindowTheme.themes": ["Dracula Pro", "Light Modern"]
}
```

Window 1 gets the first entry, window 2 the second, and the list wraps for further windows.
Names are the theme's `settingsId` — its `id`, or its `label` when it has no `id`.

## Private and paid themes need one extra step

A theme only resolves locally if its extension is *built-in*; anything else is fetched from the
Marketplace, which fails for private/`.vsix` themes. Measured: 7/7 Dracula Pro variants fail by
default, 26/26 themes pass with the farm below.

```bash
./scripts/builtin-farm.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
```

That builds `~/.per-window-theme/builtins` from symlinks — the VS Code app bundle is never modified —
and prints the launch flag to use:

```bash
code --builtin-extensions-dir "$HOME/.per-window-theme/builtins"
```

Re-run it after a VS Code update. The Dock icon can't pass the flag; launch from the terminal, or
wrap it.

## How a window picks its theme

Three rules, first match wins:

| Priority | Rule | Set by |
| --- | --- | --- |
| 1 | **This window, explicitly** | `Pick Theme (This Window)` or `Cycle Theme`. Lasts until the window is closed |
| 2 | **Remembered for this folder** | `Remember Theme For This Folder` — that directory then opens with that theme every time, in any window |
| 3 | **Window slot** | Automatic. First window gets `themes[0]`, second `themes[1]`, wrapping |

Folder memory is stored in the extension's own state, **never** in `.vscode/settings.json`, so
nothing lands in your repos and nothing gets committed by accident.

Set `perWindowTheme.unmappedStrategy` to `hash` and even unremembered folders get a stable theme
derived from their path — the same repo always looks the same, with zero configuration.

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
| `perWindowTheme.themes` | `["Dark Modern", "Light Modern"]` | Ordered theme ids, one per window slot, wrapping |
| `perWindowTheme.rememberFolders` | `true` | Remember a theme per directory |
| `perWindowTheme.unmappedStrategy` | `"slot"` | `slot` = by window order; `hash` = stable per folder path |
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
npm test                     # 32 headless tests: slots, decision tiers, folder memory
./scripts/selftest.sh        # throwaway VS Code, probes every theme, writes a JSON report
BUILTIN_FARM=1 ./scripts/selftest.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
./scripts/demo.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0   # two live windows
```

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
  extension.js     activate/deactivate, event wiring
  controller.js    this window's theme state: decide, apply, keep it applied
  decide.js        the three-tier decision, pure and vscode-free
  registry.js      cross-window slot claims (heartbeat file)
  memory.js        folder -> theme, over any Memento-shaped store
  themes.js        installed themes + the previewColorTheme call
  workspaceKey.js  how a window identifies its folder
  statusBar.js     status item and tooltip
  commands.js      command implementations
  config.js        settings accessors, stomp key list
  logger.js        output channel
  selftest.js      headless probe used by scripts/selftest.sh
scripts/           install.sh, builtin-farm.sh, selftest.sh, demo.sh
test/              run.js + one suite per module
```

## Limits

- `workbench.action.previewColorTheme` is an internal command, not public API. A VS Code update can
  rename or remove it. The extension checks the command's return value, so a break shows up as a
  visible warning rather than silence.
- Theme flash on window reload — preview state intentionally never persists.
- Private/paid themes need the built-in farm above.
- Settings Sync carries the theme list, never the per-window slot assignment.
