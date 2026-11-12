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

## The recorder's details

Copy `.env.example` to `.env.local`, which git ignores, and fill it in:

| Variable            | What it is                                          |
| ------------------- | --------------------------------------------------- |
| `DVR_HOST`          | The recorder's address on your network              |
| `DVR_PORT`          | The control port, 9000 unless it was changed        |
| `DVR_RTSP_PORT`     | The RTSP port, from the recorder's network settings |
| `DVR_USERNAME`      | A user on the recorder                              |
| `DVR_PASSWORD`      | That user's password                                |
| `DVR_RTSP_USERNAME` | The RTSP user, when it isn't `DVR_USERNAME`         |
| `DVR_RTSP_PASSWORD` | The RTSP password, when it isn't `DVR_PASSWORD`     |

Live video logs in to the RTSP port with `DVR_RTSP_USERNAME` and
`DVR_RTSP_PASSWORD` when they're set. Some recorders keep a separate RTSP
password: if live players show `wrong user/pass`, set it there.

`mise run serve:server` reads the file through 1Password's `op run`, so the
login can be `op://vault/item/field` references rather than the values
themselves. A field whose name has spaces can be referenced by its ID.

## Starting the server

```sh
mise run serve:server
```

It runs in the background through Pitchfork, at
<https://server.dvr-revival.localhost>, and serves the web client and its API.
It logs in to the recorder as it starts, and logs in again, waiting longer
each time, whenever the connection drops. `mise run serve:server:logs` follows
its log.

The server listens on `127.0.0.1:7380`. go2rtc only listens on `127.0.0.1:1984`,
and the server passes it through under `/go2rtc/`. Set `DVR_REVIVAL_HOST` to
listen on another address, such as your machine's address on your network to
use it from a phone, and `PORT` and `GO2RTC_PORT` for other ports. The server
doesn't ask for a login, so only listen where everyone who can reach it should
see the cameras.

After changing the server, restart it with `mise run serve:server:restart`.
If it doesn't come up, `op run` may be waiting for 1Password to be unlocked.

## Settings

| Variable           | Default             | What it sets                      |
| ------------------ | ------------------- | --------------------------------- |
| `DVR_REVIVAL_HOST` | `127.0.0.1`         | The address the server listens on |
| `PORT`             | `7380`              | The server's port                 |
| `GO2RTC_PORT`      | `1984`              | go2rtc's port                     |
| `GO2RTC_BIN`       | `go2rtc`            | The go2rtc binary                 |
| `DVR_REVIVAL_WEB`  | `packages/web/dist` | The built web client              |
