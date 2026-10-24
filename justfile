set shell := ["bash", "-euo", "pipefail", "-c"]

# List recipes
default:
    @just --list

# Typecheck, test and build
check:
    npm run typecheck
    npm test
    npm run build

# Set the version everywhere, check, commit and tag it: just release 1.2.3
release version: (_release-guard version)
    npm version "{{version}}" --no-git-tag-version --allow-same-version
    @# The manifest takes its version from package.json, so build after the bump.
    just check || { echo "Checks failed; undo the bump with: git checkout package.json package-lock.json" >&2; exit 1; }
    git add package.json package-lock.json
    git commit -m "chore: release v{{version}}"
    git tag -a "v{{version}}" -m "v{{version}}"
    @echo "Tagged v{{version}}. Push it to publish the release: git push origin main v{{version}}"

# The manifest version (built from package.json) only allows dot-separated numbers.
_release-guard version:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ ! "{{version}}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Version must be X.Y.Z, got '{{version}}'" >&2; exit 1
    fi
    if [[ "$(git branch --show-current)" != "main" ]]; then
      echo "Release from main" >&2; exit 1
    fi
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "Commit or stash your changes first" >&2; exit 1
    fi
    if git rev-parse -q --verify "refs/tags/v{{version}}" >/dev/null; then
      echo "Tag v{{version}} already exists" >&2; exit 1
    fi
