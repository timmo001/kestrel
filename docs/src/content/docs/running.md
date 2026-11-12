---
title: Running it
description: Set up the server and web client against your recorder.
---

You need [mise](https://mise.jdx.dev), which installs Bun, go2rtc and the
other tools at the versions the repository pins.

```sh
mise install
mise run build
```

## Your sources

The server's sources, such as a recorder, and the names you give cameras are
kept in `sources.json` in its config folder: `~/.config/kestrel` (or
`$XDG_CONFIG_HOME/kestrel`) on Linux and macOS, `%APPDATA%\kestrel` on
Windows, or the folder `KESTREL_CONFIG` names. The server writes it when you
save from the Settings page, readable only by you, and you can edit it by
hand too; restart the server after a hand edit.

The Settings page, in the app bar, lists each source with the settings its
kind takes. Add source picks a kind, Remove takes one out, and a `stream`
source lists its cameras with their addresses. Under each source, name its
cameras: the name shows across the app in place of the source's own name for
it, such as "Garden", or "Ch 3" for a recorder's numbered channel. Save restarts only the sources whose settings changed. If the
settings changed since the page loaded them, such as from another tab, the
save is refused: reload the page and make the change again.

```json
{
  "sources": [
    {
      "id": "swann",
      "kind": "raysharp",
      "name": "Swann recorder",
      "settings": { "host": "192.0.2.10", "username": "admin", "password": "…" }
    },
    {
      "id": "garden",
      "kind": "stream",
      "name": "Garden cameras",
      "settings": {},
      "cameras": [
        {
          "id": "porch",
          "name": "Porch",
          "main": "rtsp://user:…@192.0.2.20:554/stream1",
          "sub": "rtsp://user:…@192.0.2.20:554/stream2"
        },
        {
          "id": "shed",
          "name": "Shed",
          "still": "http://192.0.2.21/snapshot.jpg"
        }
      ]
    }
  ],
  "cameras": [{ "camera": "swann/1", "label": "Front door" }]
}
```

A `raysharp` source is a Raysharp-made recorder, such as a Swann DVR, with
live view, recordings, events and its disks; each channel is a camera. A
`stream` source is cameras you list yourself, each with an `id`, a `name`
and a `main` stream address, any that go2rtc plays (RTSP, RTMP, HLS, MJPEG
and more), with an optional `sub` stream for small tiles. A camera with only
a `still` address shows that picture on the Live page, a new one every few
seconds. Streams have live view only: no recordings or events.

A `reolink` source is a Reolink camera, or a Reolink Home Hub or recorder
with a camera on each channel, from its `host`, `username` and `password`.
Start the host with `https://` where its HTTP port is off. It has live view
from each camera's RTSP main and sub streams, so turn RTSP on in the
camera's network settings, and stills, motion and person, vehicle and animal
detections, read every couple of seconds, and its disks or SD card. Its
recordings aren't read yet.

A `bambu` source is a Bambu Lab P1 or A1 printer's camera, from its `host`
and the LAN `accessCode` on its network settings screen. These printers
have no video stream on the network, only a picture every second or two on
port 6000, so the camera shows on the Live page as a still, a new one every
few seconds. Turn on its LAN mode, or LAN-only liveview, for the feed to
answer.

A source's `id` names its cameras, such as `swann/3`, so links and labels
keep working as long as it stays the same. It holds logins, so keep it to
yourself. The API never sends a password back: the page shows which are set,
and a save keeps each one you didn't change.

## The recorder's details from the environment

Before there's a sources file, the server runs one Raysharp recorder, `swann`,
from the environment. A Raysharp source whose settings leave its address or
login out falls back to the same variables, so the login can stay out of the
file. Copy `.env.example` to `.env.local`, which git ignores, and fill it in:

| Variable                         | What it is                                          |
| -------------------------------- | --------------------------------------------------- |
| `KESTREL_RAYSHARP_HOST`          | The recorder's address on your network              |
| `KESTREL_RAYSHARP_PORT`          | The control port, 9000 unless it was changed        |
| `KESTREL_RAYSHARP_RTSP_PORT`     | The RTSP port, from the recorder's network settings |
| `KESTREL_RAYSHARP_USERNAME`      | A user on the recorder                              |
| `KESTREL_RAYSHARP_PASSWORD`      | That user's password                                |
| `KESTREL_RAYSHARP_RTSP_USERNAME` | The RTSP user, when it isn't the one above          |
| `KESTREL_RAYSHARP_RTSP_PASSWORD` | The RTSP password, when it isn't the one above      |

Live video logs in to the RTSP port with the RTSP user and password when
they're set. Some recorders keep a separate RTSP password: if live players
show `wrong user/pass`, set it there.

`mise run serve:server` reads the file through 1Password's `op run`, so the
login can be `op://vault/item/field` references rather than the values
themselves. A field whose name has spaces can be referenced by its ID.

So 1Password doesn't ask each time the server starts, run `mise run auth:save`
once. It fills in the references and saves the result to
`~/.config/kestrel/recorder.env`, which only you can read, and the server
uses that file while it's there. After changing the login, run it again;
`mise run auth:forget` removes the file.

## Starting the server

```sh
mise run serve:server
```

It runs in the background through Pitchfork, at
<https://server.kestrel.localhost>, and serves the web client and its API.
It starts each source as it starts, and a recorder logs in again, waiting
longer each time, whenever the connection drops. A source that can't start,
such as one with no address, shows as not connected with the reason. `mise
run serve:server:logs` follows its log.

The server listens on `127.0.0.1:7380`. go2rtc only listens on
`127.0.0.1:1984`, and the server passes it through under `/go2rtc/`; it
starts go2rtc again whenever the cameras' streams change. go2rtc's RTSP
server stays on `127.0.0.1:1985`, since its ffmpeg sources hand their output
back through it. Set `KESTREL_HOST`
to listen on another address, such as your machine's address on your network
to use it from a phone, and `KESTREL_PORT`, `KESTREL_GO2RTC_PORT` and
`KESTREL_GO2RTC_RTSP_PORT` for other ports. The server doesn't ask for a
login, so only listen where everyone
who can reach it should see the cameras and change its sources.

After changing the server, restart it with `mise run serve:server:restart`.
If it doesn't come up without a saved login, `op run` may be waiting for
1Password to be unlocked.

## Settings

| Variable                   | Default                  | What it sets                                  |
| -------------------------- | ------------------------ | --------------------------------------------- |
| `KESTREL_HOST`             | `127.0.0.1`              | The address the server listens on             |
| `KESTREL_PORT`             | `7380`                   | The server's port (`PORT` too, for Pitchfork) |
| `KESTREL_GO2RTC_PORT`      | `1984`                   | go2rtc's port                                 |
| `KESTREL_GO2RTC_RTSP_PORT` | `1985`                   | go2rtc's RTSP port, on 127.0.0.1 only         |
| `KESTREL_GO2RTC`           | `go2rtc`                 | The go2rtc binary                             |
| `KESTREL_WEB`              | `packages/web/dist`      | The built web client                          |
| `KESTREL_CONFIG`           | `~/.config/kestrel`      | Where `sources.json` is kept                  |
| `KESTREL_STATE`            | `~/.local/state/kestrel` | Where push subscriptions are kept             |
