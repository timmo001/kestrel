---
title: API
description: The server's HTTP API, which the web client reads.
---

The server's API is plain JSON over HTTP, with no login of its own. Its
OpenAPI document is at `/api/openapi.json`. Recorder times have no time zone:
they're the recorder's own clock, as it keeps them, such as
`2026-11-11T22:24:31`.

It serves **sources**, such as the recorder, and their **cameras**. A
camera's id is its source's id and its own, such as `swann/3` for the
recorder's channel 3, and its routes take the two as path segments.

| Endpoint                                             | Returns                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/sources`                                   | Each source: its kind, name and whether it's connected        |
| `GET /api/sources/:source/details`                   | Its facts, clock, storage and each camera's state             |
| `GET /api/sources/kinds`                             | Each kind of source the server runs and the settings it takes |
| `GET /api/sources/settings`                          | Every source's settings and the camera labels, no secrets     |
| `PUT /api/sources/settings`                          | Saves them and restarts the sources that changed              |
| `GET /api/attention`                                 | What needs you, each an `alert` or `passive`, with its source |
| `GET /api/cameras`                                   | Each camera: its id, name and what it can do                  |
| `GET /api/cameras/:source/:camera/recordings?date=…` | A camera's recordings on one day, such as `2026-11-11`        |
| `GET /api/cameras/:source/:camera/video?…`           | Recorded video as MP4; see below                              |
| `GET /api/recordings/days?month=…`                   | The days with recordings on any camera in a month             |
| `GET /api/events/`                                   | The last 200 events from each source, newest first            |
| `GET /api/events/live`                               | Events as server-sent events                                  |
| `GET /api/health`                                    | 204 while the server is up                                    |

A camera in `/api/cameras` says what it can do: `live` has its go2rtc stream
names, or is `null` for a camera with no live view; `recordings` and `events`
say whether it has them; `signal` is whether it has a picture now, or `null`
when its source can't tell. A source that isn't connected yet leaves its
cameras out until it knows them.

A camera's `name` is its source's name for it, such as `Channel 3`, and its
`label` the name you gave it on the Settings page, or `null`.

The settings are what `sources.json` keeps: each source's `id`, `kind`,
`name` and `settings`, its `cameras` for a kind you list cameras for
yourself, and the camera `label`s. Each kind in `/api/sources/kinds` lists
its fields, each `text`, `number`, `secret` or `address`. Reading them back
leaves secret fields out, naming the ones that are set in `secrets`, and
hides the password in an address as `********`. A save keeps each secret it
leaves out and each hidden password, checks the settings, and returns 400
with `InvalidSettings` saying what's wrong, such as two sources with one id.

A source's details are general, so any source can fill them in: `facts` are
labelled values, such as the recorder's name, firmware and channel count;
`clock` is its own time, where it keeps one; `storage` lists each disk or
card with its state; and `cameras` gives each camera's signal, what it's
recording and whether there's motion now. A source with nothing to show
returns 404 with `NotSupported`.

`/api/attention` is the status source the CLI's `status`, the page and push
read. Each source works out its own. Alerts are what needs you: a source
can't be reached, a disk is bad or unformatted, or a camera that had a signal
while the server ran has lost it. A full disk is passive, since the recorder
records over its oldest recordings; the page shows it in the source's
Storage card.

An event in `/api/events` has its source, its camera where it's about one,
its kind (such as `motion` or `PIR`), whether it started or ended, the
source's own time for it, and when the server received it.

Every endpoint that needs a source returns 503 with a `SourceUnavailable`
error while it isn't connected. An id that names no source or camera returns
404 with `UnknownSource` or `UnknownCamera`, and asking for something a
source can't do, such as a stream's recordings, returns 404 with
`NotSupported`.

## Recorded video

`GET /api/cameras/swann/1/video?begin=2026-11-11T21:46:00&end=2026-11-11T21:48:00`
sends what a camera recorded between two recorder times as fragmented MP4,
H.264 with no audio, which plays as it arrives. Add `stream=sub` for the small
sub stream, and `download=true` to have a browser save it as a file rather
than play it. `speedUp=2`, up to 4, shortens each frame so it plays that many
times faster: browsers play no faster than 16 times.

`every=1`, up to 60, sends key frames only, one per that many seconds of
recording, from the recorder's own fast forward. The whole main stream only
downloads at about 17 times real time, so it can't keep up past 16, but its
key frames come at about 58. So the page plays 32 times as `every=1` with
`speedUp=2`, at 16 times, in full resolution. The recorder runs one playback
or download at a time; the server waits up to 15 seconds for it to let go of
the last one.

- It runs across recordings, one after another, with the gaps between them
  closed up, so a range over a run of motion clips plays them back to back.
- It starts at the first key frame in the second at `begin`, and runs to the
  end of the key frame group at `end`, so about a second either side.
- It comes faster than real time, around 17 times on the main stream, so a
  minute of 1080p takes a few seconds. Nothing is kept on the server.
- A range with nothing recorded in it returns 404 with a `NoRecordings` error.
  Once video has started, a failure can only cut the response short.

The page plays it through Media Source Extensions. It sets the length from
the range, asks for video from a new `begin` when you seek past what has
loaded, and keeps only a few minutes around the playhead, as a full recording
is about 250 MB.

## Live video

The server serves go2rtc under `/go2rtc/`, its WebSocket included, so live
video plays from the same address as the page, through a proxy or over HTTPS.
Each camera's `live` in `/api/cameras` names its streams, from its id: such
as `swann_1` for the main stream and `swann_1_sub` for the sub stream. Play
one with `/go2rtc/stream.html?src=swann_1_sub`.

The DVR8-4575 offers an audio track on every stream but sends nothing on it,
and an MSE player that asks for audio waits for it forever. The page plays
video only, with go2rtc's own `video-rtc.js` player and `media` set to
`video`, so do the same in other players.

## Push

The server pushes each alert from `/api/attention` once, when it starts, to
every browser that subscribed. It follows Groundwork's push contract, outside
`/api`:

| Endpoint                     | Does                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `GET /push/vapid-key`        | The VAPID public key, as `{ publicKey }`                   |
| `POST /push/subscriptions`   | Keeps a subscription, replacing the client's last one; 204 |
| `DELETE /push/subscriptions` | Drops the subscription with `{ endpoint }`; 204            |

The page's Notify me button subscribes. The keys and subscriptions are kept in
`push.json`, readable only by you, under `KESTREL_STATE`, else
`$XDG_STATE_HOME/kestrel`, else `%LOCALAPPDATA%\kestrel` on Windows, else
`~/.local/state/kestrel`.
