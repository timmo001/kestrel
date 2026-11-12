---
name: dvr-revival
description: Read a Raysharp-made recorder's status, recordings and motion or PIR events through the DVR Revival server, and save recorded video as MP4. Use when asked whether the recorder or a camera is working, what was recorded on a day, when motion or PIR was last seen, where to watch a channel live, or to save footage from a time.
---

# DVR Revival

Prefer the `dvr-revival` Code Mode namespace, then the MCP server
(`dvr-revival mcp`); fall back to the CLI with `--json`. They talk to the
server at `DVR_REVIVAL_SERVER` (`http://127.0.0.1:7380` by default). Every
operation only reads from the recorder; `download` also writes a file here,
so it's the one write, and it's in the CLI only.

1. Start with `status`. If it isn't connected, say why from its `error` and
   stop: nothing else answers until the server is logged in to the recorder.
2. For what was recorded, use `days` for a month, then `recordings` for a
   channel (from 1) and a day. Each recording's `reasons` say why it was made:
   `PIR` and `motion` are events, `normal` is continuous recording.
3. `events` lists the alarm reports since the server started. They aren't
   confirmed on every firmware yet, so when it's empty, look for `PIR` and
   `motion` recordings instead.
4. `video` gives each channel's stream names. Live view is at
   `<server>/go2rtc/stream.html?src=<stream>`.
5. To save footage, find it with `recordings` first, then run
   `dvr-revival download --channel 1 --date 2026-11-11 --from 21:46 --to 21:48`
   (add `--json` for the file and its size, `--sub` for the small stream,
   `-o` for the file name). A range can run across recordings; gaps between
   them are closed up. The recorder sends far faster than real time, so a
   minute of 1080p takes a few seconds and about 35 MB. To watch instead,
   the page's Recordings section plays any row.

Times are the recorder's own clock, with no time zone.
