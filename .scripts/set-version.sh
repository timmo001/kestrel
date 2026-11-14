#!/usr/bin/env bash
# Sets Kestrel's version in packages/core/src/Version.ts before a build. The
# code keeps 0.0.0 and a release's build sets its tag, so a release needs no
# version bump.
#
# Usage: set-version.sh <version>
set -euo pipefail

version="$1"
file="$(dirname "$0")/../packages/core/src/Version.ts"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::'$version' isn't a version such as 1.2.3, with no v"
  exit 1
fi

sed -i "s/^export const version = \"[^\"]*\";/export const version = \"$version\";/" "$file"

if ! grep -qF "export const version = \"$version\";" "$file"; then
  echo "::error::Couldn't set the version in $file"
  exit 1
fi

echo "Kestrel's version is $version"
