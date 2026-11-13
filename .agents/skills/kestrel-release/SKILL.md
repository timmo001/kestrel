---
name: kestrel-release
description: Release Kestrel and roll it out, from the version bump and release notes to installing the Home Assistant app through the ha-bridge Code Mode tools. Use when a change needs to reach the server, web app, desktop app or CLI, when bumping the version, publishing a release, debugging the Desktop workflow's release jobs, or updating the installed app.
license: Apache-2.0
compatibility: Needs mise, Bun and the gh and ha-bridge Code Mode tools, from the kestrel repository root.
---

# Releasing Kestrel

Only released versions are packaged, so anything Kestrel ships needs a
release to reach anyone: the server, the web app, the desktop app, the CLI
and the sources. Docs, CI, skills and the OpenCode plugin, which loads from
`main`, need none.

Releases are part of this repository's rollout and need no go-ahead.

## Release

1. Set the version, with no `v`, in all three places:
   `packages/core/src/Version.ts`, `home-assistant/app/config.yaml` and
   `pkgver` in `.scripts/linux/PKGBUILD.bin`. The Desktop workflow fails
   unless the first two match each other and the tag.
2. Run `mise run check` and `mise run test`, commit
   `Bump the version to <version>` through `dot git commit` and push.
3. Write the release notes in full from `git log <last tag>..HEAD`: a short
   opening on what's new, then a section per area and a `## Fixes` section,
   each entry saying what changed for someone running Kestrel. Never ship
   generated or one-line notes. The Desktop workflow copies them into the
   Home Assistant app's `CHANGELOG.md`.
4. Create the release with `gh.release_create`, tag and title the bare
   version, `target` the bump commit's full SHA.
5. Watch the Desktop run for the release in a background shell with
   `gh run watch <id> --exit-status`. It builds each platform, attaches the
   archives, installers and their attestation, publishes the Arch package
   and the AUR package, pushes the container images, commits the app's
   changelog and dispatches to timmo001/home-assistant-apps. Check that
   repository's Update app run succeeded before installing.

## Install

Install through the `ha-bridge` Code Mode namespace, not the CLI or SSH:

1. `check_updates` with `target: { entity_id: "update.kestrel_update" }`, so
   the Supervisor reloads the app store.
2. `get_update` on `update.kestrel_update`: the latest version is the new one
   and the release notes are yours.
3. `call_action` with `action: "update.install"` on the same target.
4. `get_updates` on it: installed and latest match, nothing in progress.
5. `kestrel.status` against the app's server shows it healthy with its
   sources connected.

Only `update.kestrel_update` is installed this way. Any other Home Assistant
update still needs the user's go-ahead. The `kestrel-nvr-bin` Arch package
reaches this machine through pacman with the next system update.
