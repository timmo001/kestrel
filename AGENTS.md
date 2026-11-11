# DVR Revival

A web client and bridge for Raysharp-made recorders, starting with the Swann
DVR8-4575: recorder health, recording search and playback, motion and PIR
events, and live view. Browsers can't reach the recorder's control port or
play its RTSP streams, so a server sits between them. The plan is tracked in
timmo001/dvr-revival#1; open decisions are the issues labelled Needs Decision,
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
  `rsnet` is the protocol library, `server` holds the recorder session, `web`
  is the app.
- Use mise-pinned tools and Bun. Pin dependencies to exact versions
  (`bun add -E`) and keep `bun.lock` in sync.
- Open each hand-written source file with a short `/** */` header saying what
  it is.

## The protocol

- `packages/rsnet` follows the vendor SDK's protocol header for message
  numbers and layouts. Firmware SRV7.1.0 differs in places, and the comments
  beside the parsers say where.
- Prefer layouts from the SDK header or existing open-source clients over
  guessing. Changes that touch the wire format need a check against a real
  recorder, since there's no simulator.

## Checks and rollout

- `mise run check` runs lint, types and formatting; `mise run test` runs the
  tests. CI is off while the repository is private, so run both before a
  push. The hk pre-push hook runs the shared lints and `mise run lint`.
- Once checks pass, commit through `dot git commit` and push. Tick the step or
  issue off with a link to the commit.
