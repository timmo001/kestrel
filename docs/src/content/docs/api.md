---
title: API
description: The server's HTTP API, which the web client reads.
---

The server's API is plain JSON over HTTP, with no login of its own. Its
OpenAPI document is at `/api/openapi.json`. Recorder times have no time zone:
they're the recorder's own clock, as it keeps them, such as
`2026-11-11T22:24:31`.

| Endpoint                               | Returns                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `GET /api/connection`                  | Whether the server is logged in, since when, and the last error |
| `GET /api/attention`                   | What needs you, each an `alert` or `passive`                    |
| `GET /api/device`                      | The recorder's name, firmware, MAC and channel count            |
| `GET /api/status`                      | Its clock, disks and each channel's state                       |
| `GET /api/recordings?channel=1&date=…` | A channel's recordings on one day, such as `2026-11-11`         |
| `GET /api/days?month=…`                | The days with recordings in a month, such as `2026-11`          |
| `GET /api/events/`                     | The last 200 alarm reports, newest first                        |
| `GET /api/events/live`                 | Alarm reports as server-sent events                             |
| `GET /api/video/sources`               | Where go2rtc is served, and each channel's stream names         |
| `GET /api/health`                      | 204 while the server is up                                      |

`/api/attention` is the status source the CLI's `status`, the page and any bar
read. Alerts are what needs you: the recorder can't be reached, a disk is bad
or unformatted, or a camera that had a signal while the server ran has lost
it. A full disk is passive, since the recorder records over its oldest
recordings. A bar shows the count of alerts.

Every endpoint that needs the recorder returns 503 with a
`RecorderUnavailable` error while the server isn't logged in.

## Live video

The server serves go2rtc under `/go2rtc/`, its WebSocket included, so live
video plays from the same address as the page, through a proxy or over HTTPS.
`/api/video/sources` names two streams for each channel: `chNN` for the main
stream and `chNN_sub` for the sub stream. Play one with
`/go2rtc/stream.html?src=ch01_sub`.

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
`push.json`, readable only by you, under `DVR_REVIVAL_STATE`, else
`$XDG_STATE_HOME/dvr-revival`, else `~/.local/state/dvr-revival`.
