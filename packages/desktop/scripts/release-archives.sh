#!/usr/bin/env bash
# Packages the desktop builds for a release, as kestrel-nvr: an archive for
# each platform with the app's bundle in `lib/kestrel-nvr/` and only the
# `kestrel` command in `bin/`, which mise and aqua put on the path and the
# Linux packages unpack under /opt/kestrel-nvr. The bundle's own `bin/` has a
# `bun` that would hide the user's. Each Setup is renamed after the version
# too, longer than the archives so mise picks an archive.
#
# Usage: release-archives.sh <artifacts folder> <version> <output folder>
# where the artifacts folder holds kestrel-desktop-<os>-<arch> folders. It
# packages each build it finds, so a build job can package its own.
set -euo pipefail
# Stop inside $( … ) too, so a build that won't unpack stops the release
shopt -s inherit_errexit

artifacts="$1"
version="$2"
mkdir -p "$3"
out="$(realpath "$3")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Unpacks a build's bundle into kestrel-nvr-<version>-<platform>/lib and
# prints the folder
unpack() {
  local folder="$work/kestrel-nvr-$version-$1"
  mkdir -p "$folder/bin" "$folder/lib"
  tar --zstd -xf "$2" -C "$folder/lib"
  mv "$folder/lib/Kestrel" "$folder/lib/kestrel-nvr"
  # Electrobun's uninstaller is for its own per-user install; a package
  # manager or mise removes these
  rm -f "$folder/lib/kestrel-nvr/Resources/uninstall"
  printf '%s\n' "$folder"
}

# Linux, for each architecture built: the command is the bundle's own, by a
# link, as it finds the bundle from where it really is
for build in "Linux-X64 x64 x86_64" "Linux-ARM64 arm64 aarch64"; do
  read -r folder electrobun arch <<<"$build"
  bundle="$artifacts/kestrel-desktop-$folder/stable-linux-$electrobun-Kestrel.tar.zst"

  [ -f "$bundle" ] || continue

  platform="linux-$arch"
  linux="$(unpack "$platform" "$bundle")"
  ln -s ../lib/kestrel-nvr/Resources/app/kestrel "$linux/bin/kestrel"
  tar -czf "$out/kestrel-nvr-$version-$platform.tar.gz" -C "$work" "kestrel-nvr-$version-$platform"

  cp "$artifacts/kestrel-desktop-$folder/linux-$electrobun-Kestrel-Setup.tar.gz" \
    "$out/Kestrel-Setup-$version-$platform.tar.gz"
done

bundle="$artifacts/kestrel-desktop-Windows-X64/stable-win-x64-Kestrel.tar.zst"

if [ -f "$bundle" ]; then
  windows="$(unpack windows-x86_64 "$bundle")"
  printf '@echo off\r\n"%%~dp0..\\lib\\kestrel-nvr\\Resources\\app\\kestrel.cmd" %%*\r\n' >"$windows/bin/kestrel.cmd"
  (cd "$work" && zip -qr "$out/kestrel-nvr-$version-windows-x86_64.zip" "kestrel-nvr-$version-windows-x86_64")

  cp "$artifacts/kestrel-desktop-Windows-X64/win-x64-Kestrel-Setup.zip" \
    "$out/Kestrel-Setup-$version-windows-x86_64.zip"
fi
