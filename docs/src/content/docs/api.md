---
title: API
description: The server's HTTP API, which the web client reads.
---

The server's API is plain JSON over HTTP, for paired devices only (see
[Pairing](#pairing)). Its OpenAPI document is at `/api/openapi.json`. Recorder times have no time zone:
they're the recorder's own clock, as it keeps them, such as
`2026-11-11T22:24:31`.

It serves **sources**, such as the recorder, and their **cameras**. A
camera's id is its source's id and its own, such as `swann/3` for the
recorder's channel 3, and its routes take the two as path segments.

| Endpoint                                             | Returns                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/sources`                                   | Each source: its kind, name and whether it's connected                        |
| `GET /api/sources/:source/details`                   | Its facts, clock, storage and each camera's state                             |
| `GET /api/sources/kinds`                             | Each kind of source the server runs and the settings it takes                 |
| `GET /api/sources/settings`                          | Every source's settings and the camera labels, no secrets                     |
| `PUT /api/sources/settings`                          | Saves them and restarts the sources that changed                              |
| `GET /api/attention`                                 | What needs you, each an `alert` or `passive`, with its source                 |
| `GET /api/cameras`                                   | Each camera: its id, name and what it can do                                  |
| `GET /api/cameras/:source/:camera/recordings?date=…` | A camera's recordings on one day, such as `2026-11-11`                        |
| `GET /api/cameras/:source/:camera/video?…`           | Recorded video as MP4; see below                                              |
| `GET /api/cameras/:source/:camera/still`             | A camera's still picture now, for one with `still`                            |
| `GET /api/cameras/:source/:camera/ptz`               | Where a camera that moves has its lens zoomed, its presets, home and tracking |
| `POST /api/cameras/:source/:camera/ptz`              | Moves it, zooms it, or changes its presets, home or tracking; see below       |
| `GET /api/recordings/days?month=…`                   | The days with recordings on any camera in a month                             |
| `GET /api/events/`                                   | The last 200 events from each source, newest first                            |
| `GET /api/events/live`                               | Events as server-sent events                                                  |
| `GET /api/health`                                    | 204 while the server is up                                                    |
| `GET /api/activity/jobs`                             | Each background job's state, progress, last run and last error                |
| `GET /api/activity/usage`                            | Memory, CPU and disk use against the limits, and the last hour's readings     |
| `GET /api/devices/server`                            | The server's lasting `id` and its `name`                                      |
| `POST /api/devices/pair`                             | Pairs a device with a one-time code; see below                                |
| `POST /api/devices/code`                             | A new one-time code, and the link a QR code carries                           |
| `POST /api/devices/link`                             | A one-time sign-in path for a window, as the device asking                    |
| `GET /api/devices/`                                  | The paired devices, each with its kind and when it was last used              |
| `DELETE /api/devices/:id`                            | Unpairs a device; 204                                                         |

A camera in `/api/cameras` says what it can do: `live` has its go2rtc stream
names, or is `null` for a camera with no live view; `still` says whether it
has a still picture, which the page shows in place of video for a camera with
no live view; `recordings` and `events` say whether it has them; `signal` is whether it has a picture now, or `null`
when its source can't tell. `views` lists its pictures where it has more
than one, such as a TrackMix's `Wide` and `Telephoto` lenses, each with its
`key`, `name`, `live` streams and whether the lens `zoom` changes it; it's
empty for a camera with one. `controls.ptz` says whether it can `pan`,
`tilt`, `zoom` its lens, has `presets`, has a `home` it goes back to and
follows what it sees (`tracking`), or is `null` for a camera that
can't move. A source that isn't connected yet leaves its
cameras out until it knows them.

The settings read back carry a `revision`. A save sends back the one it read,
and is refused with `InvalidSettings` when the settings have changed since,
such as from another tab, so a page left open can't undo a newer save.

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
its kind (such as `motion`, `PIR`, or a camera's own `person`, `vehicle` or
`animal` detection), whether it started or ended, the
source's own time for it, and when the server received it.

## Pairing

Everything under `/api/`, `/go2rtc/` and `/push/` needs a paired device,
apart from `/api/health`, `/api/devices/server` and `/api/devices/pair`.
Without one it returns 401 with `Unpaired`. The page's own files stay open,
so a browser that isn't paired can load the pairing page. A server that
only listens on this machine (`KESTREL_HOST=127.0.0.1`) lets this machine
in without pairing; once it listens on the network, this machine needs a
token too.

A device pairs once with a code from `POST /api/devices/code`, such as
`ABCD-EFGH`, which works once, for five minutes. Ten wrong codes in five
minutes cancel every open one. `POST /api/devices/pair` takes
`{ code, name, kind }`, where `kind` is `browser`, `desktop`, `cli` or
`android`. A browser gets an `HttpOnly` cookie, `kestrel_session`; every
other kind gets its `token` in the reply, once, and sends it as
`Authorization: Bearer <token>`. A wrong, used or late code returns 403
with `PairingRefused`. The code's `link` is the page that pairs with it,
`<server>/pair#code=…&server=<id>`, for a QR code; it's missing when the
server has no address other devices can reach (set `KESTREL_URL` to name
one).

The server keeps only a SHA-256 hash of each token, in `devices.json` in
the state folder, and an owner token in `owner.token` beside it: whoever can
read that folder owns the server. `POST /api/devices/link` returns a path,
`auth/connect/<code>`, that signs a window in as the device asking, once,
such as the desktop app's window: opening it sets the cookie and goes to the
page.

## Finding servers

A server listening beyond this machine announces itself on the home
network over mDNS as `_kestrel._tcp`, named after the machine (or
`KESTREL_NAME`), with its `id` and `version` in the TXT record.
`KESTREL_ANNOUNCE=false` keeps it quiet.

## Versions

A client only works with a server of its own version, so the two never
disagree on the API. A client says its version in `X-Kestrel-Version`, and
a server of another version answers 426 with `VersionMismatch`, giving both
versions and how to update whichever is behind.
`GET /api/devices/server` and `/api/health` answer any version, so a client
can always learn the server's. Only released versions are packaged, so each
release's server and clients match. The page reloads once when it finds
the server was updated, and otherwise asks you to.

## Errors

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
one with `/go2rtc/stream.html?src=swann_1_sub`. `subRatio` is the width over
height to draw the sub stream at when its frames squeeze the picture into
another shape, as the DVR8-4575's 352×288 sub stream does with a 16:9
picture, and `null` when it's drawn at its own shape.

A camera's other views have streams named after them, such as
`reolink-hub_1_telephoto` for a TrackMix's telephoto lens on a Reolink hub.
It has no sub stream, so it plays its main stream in every layout.

`sound` says whether the streams carry the camera's sound, as a Reolink
camera's do. The DVR8-4575 offers an audio track on every stream but sends
nothing on it, and an MSE player that asks for audio waits for it forever, so
its `sound` is `false`. The page uses go2rtc's own `video-rtc.js` player,
with `media` set to `video,audio` where `sound` is `true` and to `video`
otherwise, so do the same in other players.

## Moving a camera

A camera with `controls.ptz` takes a command as JSON at
`POST /api/cameras/:source/:camera/ptz`, and answers 204:

- `{"_tag": "Move", "pan": 0.5, "tilt": 0}` starts it moving, each from -1
  to 1 with right and down positive, faster the further from 0. It only
  moves eight ways, so a mostly sideways move goes straight sideways. It
  stops by itself a second after the last `Move`, so send it again about
  twice a second for as long as it should keep going.
- `{"_tag": "Stop"}` stops it.
- `{"_tag": "Zoom", "level": 0.5}` zooms its lens, from 0 widest to 1
  furthest across its range. On a TrackMix it only changes the telephoto
  picture.
- `{"_tag": "Preset", "id": 0}` turns it to a preset.
- `{"_tag": "SavePreset", "name": "Gate"}` saves where it points now as a
  preset, in the first free slot. `RenamePreset` takes an `id` and a new
  `name`, and `ClearPreset` an `id`. Names are 1 to 32 characters.
- `{"_tag": "Home"}` sends it home, and `{"_tag": "SetHome"}` makes where it
  points now its home. `KeepHome` sets whether it goes home once it's left
  alone (`on`) and after how many seconds (`backAfter`).
- `{"_tag": "Track", "on": true}` turns following what it sees on or off.
  `Track` also takes what it `follows` (a list of `people`, `vehicles` and
  `animals`), its `method` (`digital` zooms the picture only,
  `digital-first` zooms then turns, `turn-first` turns first), and
  `backAfterLeaving` and `backAfterStopping`, the seconds after its subject
  leaves or stops before it goes home.

`KeepHome` and `Track` change only the fields they're sent.

`GET` on the same route gives its `zoom` now, from 0 to 1 or `null` for a
lens that doesn't zoom, its `presets`, each with its `id` and `name`, its
`home` (`on`, whether one's `set`, and `backAfter` in seconds) and its
`tracking`: `on`, what it `follows` of the `targets` it can, its `method`
of the `methods` it can, `backAfterLeaving` and `backAfterStopping`, and
the `backChoices` it takes for those. `home` and `tracking` are `null` on a
camera without them. A command a camera can't do, such as a preset on one
with none, returns 404 with `NotSupported`.

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
