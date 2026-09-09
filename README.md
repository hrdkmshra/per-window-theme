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
./install.sh          # symlinks into ~/.vscode/extensions
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
./builtin-farm.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
```

That builds `~/.per-window-theme/builtins` from symlinks — the VS Code app bundle is never modified —
and prints the launch flag to use:

```bash
code --builtin-extensions-dir "$HOME/.per-window-theme/builtins"
```

Re-run it after a VS Code update. The Dock icon can't pass the flag; launch from the terminal, or
wrap it.

## Commands

| Command | Does |
| --- | --- |
| `Per-Window Theme: Cycle Theme (This Window)` | Next theme in the list, this window only |
| `Per-Window Theme: Pick Theme (This Window)` | Quick pick, applies to this window only |
| `Per-Window Theme: Re-apply Theme` | Force re-apply |
| `Per-Window Theme: Show Status` | Slot, theme, and the live window registry |
| `Per-Window Theme: Diagnose Theme Resolution` | Probe every installed theme, report what resolves |

The status bar shows `slot N · <theme>`, with a warning icon if the theme could not be applied.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `perWindowTheme.enabled` | `true` | Kill switch |
| `perWindowTheme.themes` | `["Dark Modern", "Light Modern"]` | Ordered theme ids, one per window slot, wrapping |
| `perWindowTheme.heartbeatMs` | `5000` | How often a window refreshes its slot claim |
| `perWindowTheme.staleMs` | `20000` | When an unrefreshed claim is treated as dead |

## Tests

```bash
node test/registry.test.js   # 12 tests: slot assignment, crash recovery, races
./selftest.sh                # throwaway VS Code, probes every theme, writes a JSON report
BUILTIN_FARM=1 ./selftest.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
```

`selftest.sh` uses isolated `--user-data-dir` / `--extensions-dir`, so it cannot touch your real
editor, settings, or extensions.

Three things need human eyes, since they're two-window UI behaviour:

1. **T1** — open two windows with no folder. They should show different themes, both stable.
2. **T5** — change the theme normally (`Ctrl+K Ctrl+T`) in one window. Within about a second, both
   windows should snap back to their own assigned themes.
3. **T6** — `Developer: Reload Window`. The window returns to its own theme after a brief flash of
   the global theme.

## Limits

- `workbench.action.previewColorTheme` is an internal command, not public API. A VS Code update can
  rename or remove it. The extension checks the command's return value, so a break shows up as a
  visible warning rather than silence.
- Theme flash on window reload — preview state intentionally never persists.
- Private/paid themes need the built-in farm above.
- Settings Sync carries the theme list, never the per-window slot assignment.
