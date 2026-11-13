# Kestrel

A web client and bridge for Raysharp-made recorders, starting with the Swann
DVR8-4575: recorder health, recording search and playback, motion and PIR
events, and live view. Browsers can't reach the recorder's control port or
play its RTSP streams, so a server sits between them. The plan is tracked in
timmo001/kestrel#1; open decisions are the issues labelled Needs Decision,
and work that depends on one waits for it.

## Stack

- Runtime, package manager and test runner: Bun.
- TypeScript with Effect v4. Read the installed `effect` source before writing
  Effect code.
- Task runner: mise. Live and recorded video go through go2rtc.

## Repository

- It's public: no credentials, home paths, host names or addresses from
  anyone's network.
- Recorder credentials are never printed, logged or passed on a command line.
- Each part is a private Bun workspace package under `packages/<name>/`:
  `core` holds what every source shares (ids, shapes, errors and the
  `Source` interface), `protocol-raysharp` is the Raysharp protocol
  library, `source-raysharp` implements `Source` for Raysharp recorders,
  `source-stream` for cameras listed by their stream addresses,
  `source-reolink` for Reolink cameras and hubs, `protocol-baichuan` is
  Reolink's own protocol library, `source-bambu` for the
  camera in a Bambu Lab printer, `source-web` for live streams on web
  pages through yt-dlp, `format-mp4` reads and writes recorded
  video as MP4, `nvr` records streams to disk with ffmpeg and reads the
  recordings folder back, knowing nothing of sources,
  `server` serves the API, runs go2rtc and recording, and serves
  recordings only from the recordings folder, `web` is the app, `desktop`
  is the Electrobun desktop app that runs the server and keeps it in the
  tray, on `@timmo001/groundwork-desktop`, and `cli` is the
  `kestrel` CLI with its Code Mode and MCP surface. Its skill is
  `skills/kestrel/SKILL.md`; keep it in step with the CLI's operations.
  `opencode-plugin/` is the OpenCode plugin for that Code Mode surface. It
  sits outside the workspace, with its own `bun.lock`, so it keeps the
  Effect version `@opencode/plugin` uses.
- Name packages type first, then thing: `source-<kind>` for a source,
  `protocol-<kind>` for a protocol library.
- Anything only one kind of source has belongs in its own packages, never in
  `core`, `server`, `web`, `desktop` or `cli`; those speak only in sources, cameras and
  the general shapes in `core`.
- Use mise-pinned tools and Bun. Pin dependencies to exact versions
  (`bun add -E`) and keep `bun.lock` in sync.
- Open each hand-written source file with a short `/** */` header saying what
  it is.

## The protocol

- `packages/protocol-raysharp` follows the vendor SDK's protocol header for
  message numbers and layouts. Firmware SRV7.1.0 differs in places, and the
  comments beside the parsers say where. The mode 2 scrambling and the
  recorded video's frame header came from reverse engineering.
- Prefer layouts from the SDK header or existing open-source clients over
  guessing. Changes that touch the wire format need a check against a real
  recorder, since there's no simulator.

## Running it

- Start the server only through `mise run serve:server`, never in the
  foreground. Its sources come from `sources.json` in the config folder
  (`~/.config/kestrel`), written from the Settings page. Without one, or for
  a Raysharp source that leaves them out, it reads the recorder's address
  and login (`KESTREL_RAYSHARP_*`) from the private file `mise run
  auth:save` writes, `~/.config/kestrel/recorder.env`, or else from
  `.env.local` (see `.env.example`) through `op run`, and starts go2rtc
  beside it. Never print or copy what's in `sources.json` either.
- Scripts that talk to the recorder load the saved file with
  `bun --env-file="$HOME/.config/kestrel/recorder.env"`, so they don't
  ask 1Password each time. Never print or copy what's in it.

## Checks

- `mise run check` runs lint, types and formatting; `mise run test` runs the
  tests. Run both before a push; CI runs them again, with the shared lints,
  and the Desktop workflow builds the app on Linux and Windows. The hk
  pre-push hook runs the shared lints and `mise run lint`.

## Rollout

Changes made here are pushed as they land, with no go-ahead needed. Once
`mise run check` and `mise run test` pass for a change:

1. Commit the session's own changes through `dot git commit`, leaving other
   sessions' work alone, and push.
2. When the change has an issue or a step in the plan, tick it off there, with
   a link to the commit.
3. When the change is in what Kestrel ships, release it and install the Home
   Assistant app, without asking, through the `kestrel-release` skill.
4. Report what landed and anything flagged.

## Notifications

This project moves fast, so clear its GitHub notifications as soon as the
work settles them, without asking: a failed CI run once a later run on the
same branch passes, an issue or pull request once it's closed or answered.
List them with `dot git notifications --bar-json`, matching the repository and
title, and clear each with `dot git notifications --mark-read <id>`. Leave the
ones the work didn't settle.
