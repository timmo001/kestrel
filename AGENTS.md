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

- It's private for now, but write as if it were public: no credentials, home
  paths, host names or addresses from anyone's network.
- Recorder credentials are never printed, logged or passed on a command line.
- Each part is a private Bun workspace package under `packages/<name>/`:
  `core` holds what every source shares (ids, shapes, errors and the
  `Source` interface), `protocol-raysharp` is the Raysharp protocol
  library, `source-raysharp` implements `Source` for Raysharp recorders,
  `source-stream` for cameras listed by their stream addresses,
  `source-reolink` for Reolink cameras and hubs, `source-bambu` for the
  camera in a Bambu Lab printer,
  `server` serves the API and runs go2rtc, `web` is the app and `cli` is the
  `kestrel` CLI with its Code Mode and MCP surface. Its skill is
  `skills/kestrel/SKILL.md`; keep it in step with the CLI's operations.
- Name packages type first, then thing: `source-<kind>` for a source,
  `protocol-<kind>` for a protocol library.
- Anything only one kind of source has belongs in its own packages, never in
  `core`, `server`, `web` or `cli`; those speak only in sources, cameras and
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

## Checks and rollout

- `mise run check` runs lint, types and formatting; `mise run test` runs the
  tests. CI is off while the repository is private, so run both before a
  push. The hk pre-push hook runs the shared lints and `mise run lint`.
- Once checks pass, commit through `dot git commit` and push. Tick the step or
  issue off with a link to the commit.
