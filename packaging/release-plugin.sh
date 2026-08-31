#!/bin/sh
# Publish a speq plugin from a terminal, with the same checks CI would run.
#
#   curl -fsSL https://speqkit.github.io/speqkit/release-plugin.sh | sh
#   ./release-plugin.sh --dir packages/my-plugin
#   ./release-plugin.sh --dry-run
#
# For the release you do by hand: the first one, a plugin that lives in a
# repository with no CI, or the afternoon you need a version out and the
# runners are queued. The Actions path is
# `.github/workflows/plugin-release.yml` in this repository, and it runs the
# same three questions in the same order.
#
# The token comes from the environment and is never written anywhere:
#
#   export NPM_TOKEN=npm_xxxxxxxx      # an npm *automation* token
#   ./release-plugin.sh
#
# Without NPM_TOKEN it falls back to whatever `npm whoami` already has, so an
# author who ran `npm login` once does not need a token at all. What it will
# not do is prompt: a script that blocks on a one-time password is a script
# that hangs in a pipe at 2am.
#
# POSIX sh on purpose — this runs on whatever the machine happens to have.
set -eu

DIR="."
DRY=0
SPEQKIT_REF="${SPEQKIT_REF:-main}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help)
      echo "usage: release-plugin.sh [--dir <path>] [--dry-run]"
      echo ""
      echo "  NPM_TOKEN   an npm automation token (optional if you ran 'npm login')"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '%b\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need node
need npm

# Resolved before the `cd`, so a checkout of speqkit beside this script can be
# found afterwards.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

cd "$DIR" || die "no such directory: $DIR"
[ -f package.json ] || die "no package.json in $(pwd)"

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")

say ""
say "\033[1m$name $version\033[0m"
say "  $(pwd)"

# ------------------------------------------------------------------ build

step "1/4  build and test"
if node -p "!!(require('./package.json').scripts||{}).build" | grep -q true; then
  npm run build
else
  say "  no build script — skipping"
fi
if node -p "!!(require('./package.json').scripts||{}).test" | grep -q true; then
  npm test
else
  say "  \033[33mno test script.\033[0m A plugin with no tests against @speqkit/test-kit"
  say "  is a plugin whose first user is its first test."
fi

# --------------------------------------------------------------- conform

# Fetched rather than vendored, so the checks grow as speqkit finds new ways
# to ship something that does not load. A checkout of speqkit next to this
# script wins, which is what makes the script testable against itself and
# what a contributor gets for free; otherwise it comes off the tag. Either
# way it lives for the length of this run and nothing is left behind.
step "2/4  would this install and load?"
checker=""
cleanup() { [ -n "${fetched:-}" ] && rm -f "$fetched"; [ -n "${npmrc:-}" ] && rm -f "$npmrc"; return 0; }
trap cleanup EXIT

if [ -n "${SPEQKIT_CHECKER:-}" ]; then
  checker="$SPEQKIT_CHECKER"
elif [ -f "$here/../scripts/check-plugin-package.mjs" ]; then
  checker="$here/../scripts/check-plugin-package.mjs"
else
  need curl
  fetched=$(mktemp)
  curl -fsSL "https://raw.githubusercontent.com/speqkit/speqkit/$SPEQKIT_REF/scripts/check-plugin-package.mjs" -o "$fetched" \
    || die "could not fetch the conformance check from speqkit@$SPEQKIT_REF"
  checker="$fetched"
fi
node "$checker" . || die "the package would not install and load. Nothing was published."

# ------------------------------------------------------------- registry

step "3/4  is $version already out?"
published=$(node "$checker" . --json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).alreadyPublished")
if [ "$published" = "true" ]; then
  say "  $name@$version is already in the registry."
  say ""
  say "  Publishing is not how you change what is there. Bump the version:"
  say "    npm version patch    # or minor, or major"
  exit 0
fi
say "  no — $version is new"

# -------------------------------------------------------------- publish

step "4/4  publish"
if [ "$DRY" = "1" ]; then
  say "  \033[33mdry run\033[0m — everything above passed, nothing was published."
  exit 0
fi

# The token reaches npm through the environment variable its own config
# syntax interpolates, so it is never written to a file this script controls
# and never appears in `set -x` output.
if [ -n "${NPM_TOKEN:-}" ]; then
  npmrc=$(mktemp)
  printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > "$npmrc"
  NPM_CONFIG_USERCONFIG="$npmrc" npm publish --access public \
    || die "npm refused the publish"
else
  npm whoami >/dev/null 2>&1 \
    || die "not logged in and NPM_TOKEN is unset. Run 'npm login', or export an automation token."
  npm publish --access public || die "npm refused the publish"
fi

say ""
say "\033[32mpublished $name@$version\033[0m"
say ""
say "  Anyone can now add it:"
say "    speq add $name"
