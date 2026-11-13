#!/usr/bin/env bash
# Repackages the desktop builds for mise's GitHub backend: an archive for each
# platform with the app in `app/` and only a `kestrel` command in `bin/`, which
# mise puts on the path. The app's own `bin/` has a `bun` that would hide the
# user's. Usage: mise-archives.sh <artifacts folder> <version> <output folder>
set -euo pipefail

artifacts="$1"
version="$2"
mkdir -p "$3"
out="$(realpath "$3")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Unpacks a build into kestrel-<version>-<platform>/app and prints the folder
unpack() {
  local folder="$work/kestrel-$version-$1"
  mkdir -p "$folder/bin"
  tar --zstd -xf "$2" -C "$folder"
  mv "$folder/Kestrel" "$folder/app"
  printf '%s\n' "$folder"
}

linux="$(unpack linux-x64 "$artifacts/kestrel-desktop-Linux/stable-linux-x64-Kestrel.tar.zst")"
cat >"$linux/bin/kestrel" <<'EOF'
#!/bin/sh
# Starts the Kestrel desktop app beside this script
exec "$(dirname "$(readlink -f "$0")")/../app/bin/launcher" "$@"
EOF
chmod 755 "$linux/bin/kestrel"
tar -czf "$out/kestrel-$version-linux-x64.tar.gz" -C "$work" "kestrel-$version-linux-x64"

windows="$(unpack windows-x64 "$artifacts/kestrel-desktop-Windows/stable-win-x64-Kestrel.tar.zst")"
printf '@echo off\r\n"%%~dp0..\\app\\bin\\launcher.exe" %%*\r\n' >"$windows/bin/kestrel.cmd"
(cd "$work" && zip -qr "$out/kestrel-$version-windows-x64.zip" "kestrel-$version-windows-x64")
