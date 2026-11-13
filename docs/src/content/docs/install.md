---
title: Install
description: Install Kestrel from the timmo pacman repository or the AUR, as a Home Assistant app or container, as a .deb, .rpm or Flatpak, with mise, or from a release.
---

Kestrel is one package, `kestrel-nvr`, for Linux on x86_64 and aarch64 and
for Windows on x64. It has the desktop app, the server and the `kestrel`
command in one: `kestrel` opens the app, `kestrel serve` runs the server with
no window, and anything else is the [CLI](/agents). The server also comes as
a container image and a Home Assistant app.

Only released versions are packaged, and a client only works with a server
of the same version, so update every device together. Each one says which
side is older and how to update it when they differ.

Recording needs `ffmpeg`. The packages recommend it, and the container, the
Home Assistant app and the Flatpak bring their own.

## Arch Linux

`kestrel-nvr-bin` is in the unofficial `timmo` pacman repository, for x86_64.
Add it before the other repository sections in `/etc/pacman.conf`:

```ini
[timmo]
SigLevel = PackageRequired DatabaseOptional TrustedOnly
Server = https://packages.timmo.dev/$arch
```

```sh
sudo pacman -Syu kestrel-nvr-bin
```

It's in the AUR too, for x86_64 and aarch64:

```sh
yay -S kestrel-nvr-bin
```

The desktop app's libraries (`webkit2gtk-4.1`, `gtk3` and
`libayatana-appindicator`) and `ffmpeg` are optional, so a box with no
desktop takes the package for `kestrel serve` alone.

## Home Assistant

The Home Assistant app runs the server on Home Assistant OS, for amd64 and
aarch64. Add the repository with all my apps:

[![Add the repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Ftimmo001%2Fhome-assistant-apps)

Then install Kestrel and start it. See
[Home Assistant](/running#home-assistant).

## Container

`ghcr.io/timmo001/kestrel` runs the server, for amd64 and arm64. See
[Docker](/running#docker).

## Debian, Ubuntu and Fedora

Each [release](https://github.com/timmo001/kestrel/releases) has `.deb` and
`.rpm` packages for x86_64 and aarch64:

```sh
# Debian and Ubuntu
sudo apt install ./kestrel-nvr_<version>-1_amd64.deb

# Fedora
sudo dnf install ./kestrel-nvr-<version>-1.x86_64.rpm
```

On Debian and Ubuntu, `--no-install-recommends` leaves out the desktop
app's libraries and `ffmpeg`, for a box that only runs `kestrel serve`.

## Flatpak

Each release has a Flatpak bundle of the desktop app for x86_64, with
`ffmpeg` built in:

```sh
flatpak install --user ./kestrel-nvr-<version>-linux-x86_64.flatpak
flatpak run dev.timmo.kestrel
```

It runs in Flatpak's sandbox, so Start at login is left out; start it from
your desktop's own autostart settings instead.

## Windows

Each release has `Kestrel-Setup-<version>-windows-x86_64.zip`: unpack it and
run `Kestrel-Setup.exe`. It isn't signed, so Windows asks before running it.
When the app's server is on a newer version, the app offers to update itself
to match.

## mise

[mise](https://mise.jdx.dev) installs the release's `kestrel-nvr` archive on
Linux and Windows and keeps it up to date:

```sh
mise use -g github:timmo001/kestrel
```

Update it with `mise up`. This puts the `kestrel` command on your path,
without the menu entry or services. On Linux the app needs the desktop
libraries above; `kestrel` says which are missing.

## Release archive

Each release has a `kestrel-nvr-<version>-<platform>` archive, with the
bundle in `lib/kestrel-nvr` and the `kestrel` command in `bin`:

```sh
tar -xzf kestrel-nvr-<version>-linux-x86_64.tar.gz
kestrel-nvr-<version>-linux-x86_64/bin/kestrel serve
```

Release files come with a `SHA256SUMS` file and a GitHub attestation. Check
one with:

```sh
gh attestation verify <file> -R timmo001/kestrel
```

## Build from source

See [Running it](/running#from-source).
