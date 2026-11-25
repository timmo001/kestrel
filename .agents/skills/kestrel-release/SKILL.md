---
name: kestrel-release
description: Release Kestrel and roll it out, from the release notes and tag to restarting the installed server on its new package. Use when a change needs to reach the server, web app, desktop app or CLI, when picking the next version, publishing a release, debugging the release jobs in the Build and package application workflow, or updating the installed app.
license: Apache-2.0
compatibility: Needs mise, Bun and the gh and kestrel Code Mode tools and SSH to the server machine, from the kestrel repository root.
---

# Releasing Kestrel

Only released versions are packaged, so anything Kestrel ships needs a
release to reach anyone: the server, the web app, the desktop app, the CLI
and the sources. Docs, CI, skills and the OpenCode plugin, which loads from
`main`, need none.

Releases are part of this repository's rollout and need no go-ahead.

## Release

The release's tag is the version: the code keeps `0.0.0`, the build sets
the tag in `packages/core/src/Version.ts` before it builds, and
timmo001/home-assistant-apps sets it in the app's `config.yaml`. Never bump
the version in code.

1. Pick the next version, with no `v`, from the latest release.
2. Make sure `main` holds everything for the release and is pushed, with
   `mise run check` and `mise run test` passing.
3. Write the release notes in full from `git log <last tag>..HEAD`: a short
   opening on what's new, then a section per area and a `## Fixes` section,
   each entry saying what changed for someone running Kestrel. Never ship
   generated or one-line notes. The build workflow copies them into the
   Home Assistant app's `CHANGELOG.md`.
4. Create the release with `gh.release_create`, tag and title the bare
   version, `target` the full SHA of the commit to release.
5. Watch the Build and package application run for the release in a
   background shell with `gh run watch <id> --exit-status`. It builds each
   platform; from the Linux archives it pushes the container images and
   dispatches to timmo001/home-assistant-apps straight away, without waiting
   for the other packages. Once the .deb, .rpm and Windows builds are done
   it attaches the archives, installers and their attestation, then
   publishes the Arch package and the AUR package. It also commits the app's
   changelog. Wait for the whole run to pass before installing.

## Install

The installation in use is the `kestrel-nvr-bin` Arch package on the
always-on server machine, run by the `kestrel-nvr.service` system unit. The
`dot-machines` skill says which machine that is and how to reach it. The
Home Assistant app is installed but dormant: leave it alone, and never
install or start it.

1. Wait for the machine to upgrade the package by itself, which takes a few
   minutes after the run publishes it: over SSH, `pacman -Q kestrel-nvr-bin`
   shows the new version.
2. The upgrade doesn't restart the server, so restart it over SSH with
   `sudo -n systemctl restart kestrel-nvr`, then check
   `systemctl is-active kestrel-nvr`.
3. `kestrel.status` shows it healthy, with its sources connected.
