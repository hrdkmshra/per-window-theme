#!/usr/bin/env bash
# One-shot installer: clone (or update) Per-Window Theme, then link it into VS Code.
#
# Designed to be piped from a raw URL:
#   curl -fsSL https://raw.githubusercontent.com/hrdkmshra/per-window-theme/main/scripts/bootstrap.sh | bash
#
# Piping a remote script into a shell runs whatever that URL currently serves. If you
# would rather read it first:
#   curl -fsSL https://raw.githubusercontent.com/hrdkmshra/per-window-theme/main/scripts/bootstrap.sh -o pwt.sh
#   less pwt.sh && bash pwt.sh
#
# Env:
#   PWT_REPO    git URL to clone       (default: this repo on GitHub)
#   PWT_REF     branch/tag to check out (default: main)
#   PWT_DIR     where to keep the clone (default: ~/.per-window-theme/app)
#   PWT_FARM    space-separated theme extension dirs to register as built-in
set -euo pipefail

REPO="${PWT_REPO:-https://github.com/hrdkmshra/per-window-theme.git}"
REF="${PWT_REF:-main}"
DIR="${PWT_DIR:-$HOME/.per-window-theme/app}"

die() { echo "error: $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required"

if [ -d "$DIR/.git" ]; then
	echo "updating existing clone at $DIR"
	git -C "$DIR" fetch --quiet origin "$REF"
	git -C "$DIR" checkout --quiet "$REF"
	git -C "$DIR" reset --hard --quiet "origin/$REF"
else
	echo "cloning $REPO -> $DIR"
	mkdir -p "$(dirname "$DIR")"
	git clone --quiet --branch "$REF" --depth 1 "$REPO" "$DIR"
fi

# The extension itself has no dependencies, but packaging it needs the dev tools.
if command -v node >/dev/null 2>&1; then
	echo "running tests"
	( cd "$DIR" && node test/run.js >/dev/null ) && echo "tests passed" || echo "tests FAILED — continuing, but expect trouble" >&2
fi

if command -v npm >/dev/null 2>&1; then
	echo "installing dev tools (packager)"
	( cd "$DIR" && npm install --silent --no-audit --no-fund >/dev/null )
else
	echo "npm not found; scripts/install.sh needs it to build the .vsix" >&2
fi

bash "$DIR/scripts/install.sh"

if [ -n "${PWT_FARM:-}" ]; then
	echo
	# Unquoted on purpose: PWT_FARM is a space-separated list of directories.
	# shellcheck disable=SC2086
	bash "$DIR/scripts/builtin-farm.sh" $PWT_FARM
fi

if ! command -v code >/dev/null 2>&1; then
	echo
	echo "note: the 'code' CLI is not on PATH. The extension still works, but"
	echo "      scripts/demo.sh and the built-in farm launch flag need it."
	echo "      In VS Code: Shell Command: Install 'code' command in PATH."
fi

echo
echo "installed via code --install-extension. Clone lives at $DIR — pull there to"
echo "update, or just re-run this script."
