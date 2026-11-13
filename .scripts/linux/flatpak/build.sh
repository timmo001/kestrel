#!/usr/bin/env bash
# Builds the Flatpak bundle from a release's x86_64 kestrel-nvr archive, with
# flatpak-builder and GNOME's runtime from Flathub.
#
# Usage: build.sh <archive> <version> <output folder>
set -euo pipefail
shopt -s inherit_errexit

archive="$(realpath "$1")"
version="$2"
mkdir -p "$3"
out="$(realpath "$3")"
here="$(cd "$(dirname "$0")" && pwd)"
manifest="$here/dev.timmo.kestrel.yml"
work="$(mktemp -d)"
trap 'rm -rf "$work" "$here/kestrel-nvr.tar.gz"' EXIT

runtime="$(sed -n 's/^runtime-version:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")"

flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y --noninteractive flathub \
  "org.gnome.Platform//$runtime" "org.gnome.Sdk//$runtime"

cp "$archive" "$here/kestrel-nvr.tar.gz"

flatpak-builder --user --force-clean --disable-rofiles-fuse \
  --repo="$work/repo" --state-dir="$work/state" "$work/build" "$manifest"

flatpak build-bundle "$work/repo" "$out/kestrel-nvr-$version-linux-x86_64.flatpak" dev.timmo.kestrel
