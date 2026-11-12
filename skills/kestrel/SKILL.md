---
name: kestrel
description: Read your cameras' status, recordings and motion or PIR events through the Kestrel server, starting with a Raysharp-made recorder, and save recorded video as MP4. Use when asked whether the recorder or a camera is working, what was recorded on a day, when motion or PIR was last seen, where to watch a camera live, or to save footage from a time.
---

# Kestrel

Prefer the `kestrel` Code Mode namespace, then the MCP server
(`kestrel mcp`); fall back to the CLI with `--json`. They talk to the
server at `KESTREL_SERVER` (`http://127.0.0.1:7380` by default). Every
operation only reads from the sources; `download` also writes a file here,
so it's the one write, and it's in the CLI only.

Cameras are named by id: their source's id and their own, such as `swann/3`
for the recorder's channel 3.

1. Start with `status`. If a source isn't connected, say why from its
   `connection.error` and stop: its cameras don't answer until it is. Its
   `details` give each connected source's clock, storage and each camera's
   state; `details` alone gives one source's, with its facts.
2. `cameras` lists each camera's id, name (or the `label` you gave it) and
   what it can do: `live`, `still`, `recordings` and `events`, and `signal`
   for whether it has a picture now (`null` when its source can't tell).
   A camera with `still` has a picture at
   `<server>/api/cameras/<source>/<camera>/still`.
3. For what was recorded, use `days` for a month, then `recordings` for a
   camera and a day. Each recording's `reasons` say why it was made: `PIR`
   and `motion` are events, `normal` is continuous recording.
4. `events` lists the events since the server started, each with its source
   and camera. They aren't confirmed on every firmware yet, so when it's
   empty, look for `PIR` and `motion` recordings instead.
5. A camera's `live` gives its stream names. Live view is at
   `<server>/go2rtc/stream.html?src=<stream>`.
6. To save footage, find it with `recordings` first, then run
   `kestrel download --camera swann/1 --date 2026-11-11 --from 21:46 --to 21:48`
   (add `--json` for the file and its size, `--sub` for the small stream,
   `-o` for the file name). A range can run across recordings; gaps between
   them are closed up. The recorder sends far faster than real time, so a
   minute of 1080p takes a few seconds and about 35 MB. To watch instead,
   the page's Recordings section plays any row.

Times are the recorder's own clock, with no time zone.
