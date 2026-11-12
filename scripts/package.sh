#!/usr/bin/env bash
# Zips dist/chrome and dist/firefox for the stores, plus the source archive AMO reviewers rebuild
# from (the shipped code is bundled by esbuild, so AMO requires it). Run after `npm run build`.
# Writes dist/packages/interlinear-{chrome,firefox,source}-<version>.zip and SHA256SUMS.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="$(node -p 'require("./package.json").version')"
out="$root/dist/packages"

# The source zip comes from the committed tree; uncommitted edits would make it differ from dist/.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash your changes first: the source zip must match the build" >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$out"
for target in chrome firefox; do
  [[ -f "dist/$target/manifest.json" ]] || { echo "dist/$target is missing; run npm run build" >&2; exit 1; }
  (cd "dist/$target" && zip -qr -X "$out/interlinear-$target-$version.zip" .)
done
git archive --format=zip --prefix="interlinear-$version/" -o "$out/interlinear-source-$version.zip" HEAD
(cd "$out" && sha256sum interlinear-*.zip > SHA256SUMS)
echo "Packaged into dist/packages"
