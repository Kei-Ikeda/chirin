#!/usr/bin/env bash
# Preflight for a chirin release: the CI checks in their CI order, the .vsix, proof that the
# .vsix carries no sources, and the checksum written under .tmp/.
#
# This is a script rather than a list of commands because the "no sources shipped" check is an
# inverted grep - success is *no* output - which is easy to write backwards by hand and would
# then pass silently on a broken package. Run it from anywhere inside the repository.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

version=$(node -p "require('./package.json').version")
vsix="chirin-${version}.vsix"
echo "==> chirin ${version}"

# Packaging is not byte-reproducible, so rebuilding a released version silently replaces the
# file whose checksum is already published. The tag is pushed as part of releasing, so its
# existence means this version is out: stop rather than overwrite the artefact.
if git rev-parse -q --verify "refs/tags/v${version}" >/dev/null; then
  cat >&2 <<MSG
v${version} is already tagged, so it is already released.

Rebuilding it would produce different bytes and invalidate the checksum that has been
published with it. Bump the version instead; to get the released bytes back, download them:

  curl -sSLO https://github.com/Kei-Ikeda/chirin/releases/download/v${version}/${vsix}
MSG
  exit 1
fi

npm run check:zero-deps
npm test
npx vsce package

[ -f "$vsix" ] || { echo "expected ${vsix} at the repository root" >&2; exit 1; }

leaked=$(unzip -Z1 "$vsix" | grep -E '^extension/(src/|dist/test/|.*\.map$)' || true)
if [ -n "$leaked" ]; then
  echo "the .vsix ships files it must not carry:" >&2
  echo "$leaked" >&2
  exit 1
fi

mkdir -p .tmp
shasum -a 256 "$vsix" > ".tmp/${vsix}.sha256"

echo
echo "packaged  ${vsix}  (kept at the repository root, gitignored, alongside past releases)"
echo "checksum  .tmp/${vsix}.sha256"
cat ".tmp/${vsix}.sha256"
