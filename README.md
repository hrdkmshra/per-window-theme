# Per-Window Theme

Give every open VS Code window its own color theme, at the same time — without creating a workspace
file, without folder-scoped settings, and without forking VS Code.

![status](https://img.shields.io/badge/status-working%20PoC-brightgreen) ![tests](https://img.shields.io/badge/tests-32%20passing-brightgreen) ![vscode](https://img.shields.io/badge/verified-1.108.0%20%2F%20macOS-blue)

## The problem

Two VS Code windows side by side — say prod on the left, a scratch repo on the right — look
identical. Every few minutes you type into the wrong one, because there is no visual difference.
The obvious fix is "give them different themes", and VS Code does not let you:

| What you'd try | What actually happens |
| --- | --- |
| Set `workbench.colorTheme` in User settings | One value shared by **every** window. Changing it recolors them all |
| Set it in Workspace or Folder settings | Works — but forces a `.code-workspace` file or a `.vscode/settings.json` in the repo, which then gets committed, argued about, or reverted |
| Look for a "per window" setting | Doesn't exist. VS Code's config scopes go User → Workspace → Folder. There is no window scope; the one named `WINDOW` explicitly means *"settable in user or workspace settings"*, both of which are shared |
| `workbench.colorCustomizations` | Also a setting, so also global. Dead end |
| Profiles (`code --profile`) | Genuinely per-window, but a profile carries its own settings **and** its own extension set, and switching needs a window relaunch. Heavy for "I just want a different color" |

So the honest summary: **VS Code has no supported way to do this.** Every route runs through the
settings stack, and the settings stack is shared.

## The solution

VS Code *applies* a theme and *saves* a theme in two separate steps, and there is an internal path
that does the first without the second — `setColorTheme(theme, 'preview')`. It repaints the window
and deliberately writes nothing to settings. Because theme state lives in the window's own renderer
process, a preview is **per-window by construction**: there is no shared value for two windows to
fight over.

That path is reachable from an extension through the `workbench.action.previewColorTheme` command.
This extension gives each window a number, then previews that window's theme into it — so two
windows disagree about their theme, permanently, while sharing one settings file and one set of
extensions.

Full derivation, with source citations and the four approaches that turned out to be dead ends, is in
[.spec/SPEC.md](.spec/SPEC.md).

## Install in one line

Replace `OWNER/REPO` with your GitHub path (see [Publishing](#publishing) if you have not pushed yet):

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/scripts/bootstrap.sh | bash
```

Using a paid or privately distributed theme? Register it as built-in in the same run:

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/scripts/bootstrap.sh \
  | PWT_FARM="$HOME/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0" bash
```

Then **fully quit VS Code** (Cmd+Q, not just closing the window) and reopen.

Piping a URL into a shell runs whatever that URL serves right now. To read it first:

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/scripts/bootstrap.sh -o pwt.sh
less pwt.sh && bash pwt.sh
```

`bootstrap.sh` clones to `~/.per-window-theme/app`, runs the tests if node is present, then links the
clone into `~/.vscode/extensions`. Re-running it updates in place. Knobs: `PWT_REPO`, `PWT_REF`,
`PWT_DIR`, `PWT_EXT_DIR`, `PWT_FARM`.

## Install from a clone

No build step, no dependencies, no packaging.

```bash
git clone https://github.com/OWNER/REPO.git per-window-theme
cd per-window-theme
npm test              # optional, ~1s, no VS Code involved
./scripts/install.sh  # symlink into ~/.vscode/extensions
```

Then fully quit VS Code and reopen. That last step matters: VS Code caches scanned extension
manifests, so a reload alone will not pick up a newly linked extension.

Verify it worked: open two windows with no folder. They should show different themes, and each status
bar should show a theme name. If not, run `Per-Window Theme: Show Status` from the command palette.

## Configure

### Choose your themes

```jsonc
// settings.json
{
  "perWindowTheme.themes": ["Dracula Pro", "Light Modern"]
}
```

First window gets the first entry, second the second, wrapping for more. Use the theme's **id** —
which is its `id` field, or its display `label` when it has no `id`. Run
`Per-Window Theme: Diagnose Theme Resolution` to print every valid id on your machine.

### If you use a paid or privately distributed theme

Themes only resolve locally when their extension ships *with* VS Code; anything else is fetched from
the Marketplace, which fails for a theme installed from a `.vsix` that isn't publicly listed.
Measured on this machine: all 7 Dracula Pro variants fail by default, and all 26 themes pass with the
workaround below.

```bash
./scripts/builtin-farm.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
```

That builds `~/.per-window-theme/builtins` out of symlinks — **the VS Code app bundle is never
touched**, so its code signature stays intact — and prints the flag to launch with:

```bash
code --builtin-extensions-dir "$HOME/.per-window-theme/builtins"
```

Re-run it after a VS Code update. Launching from the Dock can't pass the flag, so either start from
the terminal or wrap it in an alias.

## Try it without installing anything

Opens two throwaway windows with different themes, using isolated config and extension directories,
so your real editor is untouched and no restart is needed:

```bash
./scripts/demo.sh ~/.vscode/extensions/dracula-theme-pro.theme-dracula-pro-1.1.0
```

## Daily use

| You want | Do |
| --- | --- |
| A different theme in this window | Click the theme name in the status bar |
| This directory to always use a theme | `Per-Window Theme: Remember Theme For This Folder` |
| To know why this window looks like this | Hover the status bar, or `Show Status` |
| To reset the folder mappings | `Clear All Remembered Folders` |

Folder mappings are stored in the extension's own state, never in `.vscode/settings.json`, so
nothing lands in your repos.

Every command, every setting, the module layout, and the test suite:
[docs/REFERENCE.md](docs/REFERENCE.md).

## Uninstall

```bash
rm ~/.vscode/extensions/local.per-window-theme-0.0.1   # the symlink only
rm -rf ~/.per-window-theme                             # clone + built-in farm, if used
```

Then quit and reopen VS Code. Your `workbench.colorTheme` was never modified, so every window goes
back to your normal theme.

## Publishing

This repo has no remote yet, so the `raw.githubusercontent.com` URLs above 404 until you push:

```bash
gh repo create per-window-theme --private --source=. --remote=origin --push
```

Note that `raw.githubusercontent.com` only serves **public** repos anonymously. For a private repo,
either clone it instead of using the one-liner, or make it public.

## Honest limitations

- `workbench.action.previewColorTheme` is an **internal** command, not public API. A VS Code update
  could rename or remove it. The extension checks its return value, so a break shows up as a visible
  warning rather than silently doing nothing. Fine for personal use; know what you're relying on.
- A window reload briefly flashes your normal theme before the extension re-applies. Unavoidable:
  the whole point is that the per-window choice is never persisted.
- Settings Sync will carry your theme list, never the per-window assignments.
