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
| `GET /api/device`                      | The recorder's name, firmware, MAC and channel count            |
| `GET /api/status`                      | Its clock, disks and each channel's state                       |
| `GET /api/recordings?channel=1&date=…` | A channel's recordings on one day, such as `2026-11-11`         |
| `GET /api/days?month=…`                | The days with recordings in a month, such as `2026-11`          |
| `GET /api/events/`                     | The last 200 alarm reports, newest first                        |
| `GET /api/events/live`                 | Alarm reports as server-sent events                             |
| `GET /api/video/sources`               | go2rtc's port and each channel's stream names                   |
| `GET /api/health`                      | 204 while the server is up                                      |

Every endpoint that needs the recorder returns 503 with a
`RecorderUnavailable` error while the server isn't logged in.

## Live video

`/api/video/sources` names two go2rtc streams for each channel: `chNN` for the
main stream and `chNN_sub` for the sub stream. Play one from go2rtc on the
same host, such as `http://<host>:1984/stream.html?src=ch01_sub`.
