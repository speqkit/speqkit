#!/bin/sh
# speqkit installer.
#
#   curl -fsSL https://speqkit.github.io/speqkit/install.sh | sh
#   curl -fsSL https://speqkit.github.io/speqkit/install.sh | sh -s -- --version v0.3.0
#
# Downloads one executable, checks its sha256 against the checksum published
# beside it, and puts it on PATH. Nothing else is installed and nothing is
# compiled: `speq` carries its own runtime, which is the entire point of it.
#
# POSIX sh on purpose — this runs on whatever a CI image happens to have.
set -eu

REPO="speqkit/speqkit"
VERSION=""
BIN_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      echo "usage: install.sh [--version vX.Y.Z] [--bin-dir <dir>]"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need curl
need tar

# ---------------------------------------------------------------- platform

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "no build for $os. Install with npm instead: npm i -g speqkit" ;;
esac

arch=$(uname -m)
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) die "no build for $arch. Install with npm instead: npm i -g speqkit" ;;
esac

# ---------------------------------------------------------------- version

if [ -z "$VERSION" ]; then
  # The redirect on /releases/latest, rather than the API, so that a rate
  # limited or token-less CI runner is not turned away.
  VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" | sed 's|.*/tag/||')
  [ -n "$VERSION" ] || die "could not determine the latest version; pass --version"
fi

archive="speqkit-$VERSION-$os-$arch.tar.gz"
# Overridable so that the release job can point this at the artefacts it just
# built and prove the script works *before* a tag exists, rather than finding
# out from the first person who runs it.
base="${SPEQKIT_BASE_URL:-https://github.com/$REPO/releases/download/$VERSION}"

# ---------------------------------------------------------------- download

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "speqkit $VERSION  ($os-$arch)"
say "  downloading $archive"
curl -fsSL "$base/$archive" -o "$tmp/$archive" \
  || die "$base/$archive could not be downloaded"
curl -fsSL "$base/$archive.sha256" -o "$tmp/$archive.sha256" \
  || die "no checksum published for $archive; refusing to install it"

say "  verifying sha256"
expected=$(cut -d' ' -f1 < "$tmp/$archive.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
else
  die "neither sha256sum nor shasum is available; refusing to install unverified"
fi
[ "$expected" = "$actual" ] || die "checksum mismatch
  expected $expected
  actual   $actual"

tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/speq" ] || die "$archive did not contain speq"
chmod +x "$tmp/speq"

# ---------------------------------------------------------------- install

if [ -z "$BIN_DIR" ]; then
  # No sudo, ever: a test runner is not worth a password prompt in a pipe.
  # /usr/local/bin when it is already writable, and a user directory otherwise.
  if [ -w /usr/local/bin ] 2>/dev/null; then
    BIN_DIR=/usr/local/bin
  else
    BIN_DIR="$HOME/.local/bin"
  fi
fi
mkdir -p "$BIN_DIR"

mv "$tmp/speq" "$BIN_DIR/speq"
# Only matters for a file that arrived through a browser, but it costs nothing
# and the failure it prevents ("speq is damaged") reads like a broken build.
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$BIN_DIR/speq" 2>/dev/null || true
fi

say ""
say "installed $BIN_DIR/speq"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add it:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

say ""
say "  speq init      scaffold .speq/ in this repository"
say "  speq install   fetch the plugins it asks for"
say "  speq run       run the suites"
