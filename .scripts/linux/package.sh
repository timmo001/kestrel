#!/usr/bin/env bash
# Makes the .deb and .rpm for one architecture from a release's kestrel-nvr
# archive: stages the app's bundle under /opt/kestrel-nvr, the menu icons
# from the logo and the files beside this script, then runs nFPM there with
# nfpm.yaml.
#
# Usage: package.sh <archive> <version> <x86_64|aarch64> <output folder>
set -euo pipefail
shopt -s inherit_errexit

archive="$1"
version="$2"
arch="$3"
mkdir -p "$4"
out="$(realpath "$4")"
root="$(cd "$(dirname "$0")/../.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

case "$arch" in
  x86_64) goarch=amd64 ;;
  aarch64) goarch=arm64 ;;
  *)
    echo "No packages for $arch" >&2
    exit 1
    ;;
esac

tar -xzf "$archive" -C "$stage"
mkdir -p "$stage/opt"
mv "$stage/kestrel-nvr-$version-linux-$arch/lib/kestrel-nvr" "$stage/opt/kestrel-nvr"

logo="$root/packages/web/src/logo.svg"

for size in 16 32 48 64 128 256 512; do
  mkdir -p "$stage/icons/${size}x$size/apps"
  rsvg-convert -w "$size" -h "$size" "$logo" -o "$stage/icons/${size}x$size/apps/kestrel-nvr.png"
done

mkdir -p "$stage/icons/scalable/apps"
cp "$logo" "$stage/icons/scalable/apps/kestrel-nvr.svg"

linux="$root/.scripts/linux"
cp "$linux/kestrel-nvr.desktop" "$linux/kestrel-nvr.user.service" \
  "$linux/kestrel-nvr.system.service" "$linux/kestrel-nvr.sysusers" \
  "$linux/postinstall.sh" "$root/LICENSE" \
  "$root/packages/desktop/licenses/go2rtc.LICENSE" \
  "$root/packages/desktop/licenses/yt-dlp.LICENSE" \
  "$root/packages/desktop/licenses/yt-dlp.THIRD_PARTY_LICENSES" "$stage/"
cp "$stage/opt/kestrel-nvr/Resources/app/node/LICENSE" "$stage/node.LICENSE"

# nFPM reads the files from where it runs
cd "$stage"

for packager in deb rpm; do
  ARCH="$goarch" VERSION="$version" \
    nfpm package --config "$linux/nfpm.yaml" --packager "$packager" --target "$out"
done
