---
title: Running it
description: Run a Kestrel server, pair your devices with it, and set up its sources.
---

One Kestrel server keeps your sources, recordings and events, and every
other device uses it: the desktop app, a browser, a phone or the `kestrel`
command. Run it somewhere that stays on, such as Home Assistant or a box on
your network, and pair each device with it once. [Install](/install) has
every package.

## Ways to run a server

### Home Assistant

The [Home Assistant app](/install) runs the server on Home
Assistant OS. Open **Kestrel** from the sidebar: Home Assistant has already
signed you in, so it needs no pairing. It hides Home Assistant's sidebar to
give Kestrel the whole screen; the menu button at the start of the app bar,
or in its menu on a phone, shows it again, and the app's `hide_sidebar`
option keeps it. Other devices pair with it at
`http://homeassistant.local:7380`. The app shares the host's network, so it
announces itself where devices can find it, and runs go2rtc on port 11984,
out of the way of another go2rtc, such as Frigate's. Recordings go in Home
Assistant's media folder, under `kestrel`, and settings and paired devices
in the app's own data.

### Docker

The [container image](/install) runs as its own `kestrel` user and keeps its
config, state and recordings in `/data`, with `ffmpeg` built in. On the
host's network it announces itself so devices find it; with `-p 7380:7380`
instead, pair them by its address. Cameras can only send it their clips on
the host's network. `docker exec kestrel kestrel pair` shows a
code for the first device.

### Linux services

The `.deb`, `.rpm` and Arch packages have two services, both off until you
turn one on:

```sh
# As you, with your own folders, while you're logged in
systemctl --user enable --now kestrel-nvr

# As its own kestrel user, with nobody logged in
sudo systemctl enable --now kestrel-nvr
sudo -u kestrel -H kestrel pair
```

The system service keeps everything in `/var/lib/kestrel-nvr`. For the user
service to run while you're logged out, run `loginctl enable-linger`.

### By hand

`kestrel serve` runs the server with no window. It listens on every address
on port 7380, so pair each device with it.

### The desktop app

The [desktop app](#desktop-app) runs this computer's own server, or uses
another one.

## Pairing a device

A server answers only devices paired with it, apart from its page and what
pairing needs. A device pairs once with a one-time code, good for five
minutes. Get one from Settings, Devices on a paired browser, which shows a
QR code for a phone too, or with `kestrel pair` on the server's own machine,
as the user the server runs as. Then:

- In a browser, open the server's address and type the code, or scan the QR
  code with a phone.
- In the desktop app, choose **Use another server…** in the tray.
- With the CLI, run `kestrel pair <code>`.

Servers announce themselves on the network over mDNS, as `_kestrel._tcp`, so
the desktop app and `kestrel servers` list them, and find a paired one again
when its address changes. Remove a device in Settings, Devices, or with
`kestrel devices remove <id>`, and it's signed out at once. A server that
listens on `127.0.0.1` alone trusts this computer, so it needs no pairing
from it.

Everything travels over plain HTTP, so keep the server on your own network.
To reach it from outside, put it behind a reverse proxy with HTTPS.

## Installing the app

Over HTTPS, or on `localhost`, the page installs as an app: it opens in its
own window, starts without a connection, and its icon's menu goes straight to
Recordings, Events or Sources. A browser that offers installs to the page,
such as Chrome or Edge, gets a banner offering it once. Not now puts the
banner away for good in that browser, and Install stays in Settings for as
long as the browser can install it. Other browsers install from their own
menu, such as Safari's Add to Home Screen.

## Your sources

The server's sources, such as a recorder, and the names you give cameras are
kept in `sources.json` in its config folder: `~/.config/kestrel` (or
`$XDG_CONFIG_HOME/kestrel`) on Linux and macOS, `%APPDATA%\kestrel` on
Windows, or the folder `KESTREL_CONFIG` names. The server writes it when you
save from the Settings page, readable only by you, and you can edit it by
hand too; restart the server after a hand edit.

The Settings page, in the app bar, lists each source as a panel that opens
to the settings its kind takes; opening one closes the one open before. Add
source picks a kind, Remove takes one out, and a `stream` source lists its
cameras with their addresses. Under each source, name its cameras: the name
shows across the app in place of the source's own name for it, such as
"Garden", or "Ch 3" for a recorder's numbered channel. Camera order, below
the sources, sets the order cameras show in across the app: drag one by its
handle, or focus the handle and move it with the arrow keys, Home and End.
Cameras left out of the order, such as a new source's, follow in the order
their sources give them. Save restarts only
the sources whose settings changed. If the settings changed since the page
loaded them, such as from another tab, the save is refused: reload the page
and make the change again.

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
  "cameras": [{ "camera": "swann/1", "label": "Front door" }],
  "order": ["garden/porch", "swann/1"]
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
detections, read every couple of seconds, and its disks or SD card. A hub
or recorder's recordings are copied into the recordings folder like a
recorder's: each file is replayed over port 9000, Reolink's own protocol,
and put in an MP4 with ffmpeg as it was recorded, H.265 included, so
nothing is converted. Browsers that can't play H.265 say so on the
Recordings page; download the clip to play it in another player. A
camera's own SD card recordings are listed beside the server's, marked as
on the source only and faded on the timeline, but not copied or played: it
cuts a download short, and older firmware won't replay a file.
Record the camera on the server for footage you can play, or turn on
**Send clips to Kestrel** on its source in Settings. That points the
camera's FTP uploads at the server's own receiver, on port 7381 with data
on ports 7390 to 7399, with a login the server makes for it, and runs the
camera's own test where it has one. Each clip it sends when it sees motion
is kept as a motion clip, for the clip hours, and plays like any other.
Turning it off stops the camera sending.

A `bambu` source is a Bambu Lab P1 or A1 printer's camera, from its `host`
and the LAN `accessCode` on its network settings screen. These printers
have no video stream on the network, only a picture every second or two on
port 6000, so the camera shows on the Live page as a still, a new one every
few seconds. Turn on its LAN mode, or LAN-only liveview, for the feed to
answer.

The printer's recordings come from its storage over FTPS on port 990, with
the same access code: what its camera records during prints, as the
camera's continuous footage, and the timelapse of each print, as a second
camera, such as `bambu/timelapse`. They're MJPEG, so each is converted to
H.264 with ffmpeg as it's copied or played, one at a time. Set
`KESTREL_FFMPEG` for an ffmpeg that isn't on the path; it needs `libx264`.

A `web` source is live streams from web pages you list, each with an `id`,
a `name` and a `page`: a Twitch channel, a YouTube live stream, or any other
page [yt-dlp](https://github.com/yt-dlp/yt-dlp) reads, from an `http://` or
`https://` address. A page's stream address carries a token that soon runs
out, so go2rtc runs yt-dlp each time a stream starts, or starts again after
it drops, for the address that works then. That makes a web camera slower
to start than one on your network, a few seconds or more. They have live
view only: no recordings, events or stills.

The desktop app, the release archives, the Linux packages and the Home
Assistant app have their own yt-dlp, and Node.js for the sites yt-dlp reads
with JavaScript, such as YouTube; elsewhere, set `KESTREL_YT_DLP` and
`KESTREL_NODE` for ones that aren't on the path. go2rtc copies each stream
through ffmpeg, the one `KESTREL_FFMPEG` names or the one on the path. Sites
change, and yt-dlp catches up in its releases, so a page that stops playing
may need a newer one.

Keep to each site's terms. Some don't allow their streams to be shown
elsewhere, and Twitch's ads play in the stream as they would on its page.

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

## Copying your setup to another server

To move to a server on another machine, such as the Home Assistant app,
pair the CLI with it (see [Agents](/agents)), then run:

```sh
kestrel config copy --server http://<server>:7380
```

It sends this machine's sources, their logins, the camera names and order,
and what's recorded and for how long, through the other server's API, so
there's no SSH or Docker involved. A field your `sources.json` leaves empty
is filled in from the environment or `~/.config/kestrel/recorder.env`,
such as `KESTREL_RAYSHARP_PASSWORD`. The recordings folder is left to the
other server, since it's a path on this machine. Where the other server
has sources this machine doesn't, it stops and says which; `--replace`
drops them. The logins travel over plain HTTP, so copy over your own
network, not across the internet.

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

`serve:server` listens on `127.0.0.1:7380`, so it trusts this machine and
needs no pairing. go2rtc only listens on `127.0.0.1:1984`, and the server
passes it through under `/go2rtc/`; it starts go2rtc again whenever the
cameras' streams change. go2rtc's RTSP server stays on `127.0.0.1:1985`,
since its ffmpeg sources hand their output back through it. Set
`KESTREL_HOST` to listen on another address, such as `::` to use it from a
phone, where every device [pairs](#pairing-a-device) first, and
`KESTREL_PORT`, `KESTREL_GO2RTC_PORT` and `KESTREL_GO2RTC_RTSP_PORT` for
other ports.

## Desktop app

The desktop app opens the web client in a window and keeps running in the
tray. It either runs this computer's own server or uses another one, never
both, so there's one copy of the footage and nothing records a camera
twice. [Install](/install) has it for Linux and Windows.

Its own server listens on `127.0.0.1:7380` like `serve:server`, with go2rtc
built in, and takes its sources from `sources.json`. For a recorder that
leaves its address and login out there, it reads the file `mise run
auth:save` keeps; it doesn't read `.env.local`, since that needs 1Password.
Recording needs `ffmpeg` on the path, or `KESTREL_FFMPEG`. Tick **Share with
other devices** in the tray to have it listen on the network too, so other
devices can pair with it; the window then signs in as the server's owner.

To use another server, such as the Home Assistant app, choose **Use another
server…** in the tray. It lists the servers on the network, or takes an
address, and pairs with a code from that server's Settings, Devices. The
app's own server stops, and the window opens the other server's page,
signed in as this computer. **Use this computer's server** goes back. The
choice is kept in `desktop.json` in the config folder. When the other
server moves to a new address, the app finds it again by its id.

The app and its server must run the same version. When they don't, the
tray and window say which is older and how to update it. On Windows, where
the app installs itself, **Update Kestrel** downloads that version's Setup,
checks it against the release's `SHA256SUMS` and runs it; elsewhere it opens
the release and your package manager updates it.

Closing the window leaves it running in the tray. The tray menu opens the
window again, shows how the server is doing, chooses the server, opens these
docs and quits. The docs are built into the app, so they open in your
browser without a connection, from the tray or the page's More menu. If its
own server stops, the app starts it again, waiting longer each time up to
30 seconds. Opening the app again while it runs brings its window to the
front. The Windows build hasn't been tried on a real machine yet.

Tick Start at login in the tray to start it in the tray when you log in. It
adds `~/.config/autostart/dev.timmo.kestrel.desktop`; untick it to remove
that again. It's Linux only. With mise, Start
at login points at that version, so tick it again after upgrading.

While the app runs its own server, stop the background one with `mise run
serve:server:stop`: both use ports 7380 and 1984 and the same recordings
folder.

| Task                       | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `mise run desktop:start`   | Builds the app for development and opens it                                       |
| `mise run desktop:build`   | Builds the release, in `packages/desktop/artifacts`                               |
| `mise run desktop:install` | Builds the release and installs it for you, in `~/.local/share/dev.timmo.kestrel` |

## Recordings

Recordings are local first: the web client and CLI play from the
recordings folder on the server wherever it has a copy. The server writes
its own recordings there, and copies each source's in beside them, with
why each was made, such as motion, in the file's name:
`<day>/<time>.motion.mp4`. What a source has that isn't copied yet, such
as footage older than the hours kept, is listed too, marked as on the
source, and plays from it. A source that can't hand its recordings over,
such as a Reolink camera's SD card, has them listed as on the source only,
faded on the timeline, with no Play or Download, unless the camera sends
its clips to the server itself.

### Copying from sources

Every 10 minutes the server looks at what each source with recordings of
its own, such as a recorder, has from within the hours kept, and copies
what the folder doesn't have yet. It copies one file at a time, at full
quality: clips first, then continuous footage, newest first, and reads no
faster than the copy rate under [Background work](#background-work). A file
is written beside its final name and moved into place once whole. Past the
disk share, a file is only copied when an older one would be cleared out
to make room for it.

### Recording cameras

The server can record cameras itself, for those whose source keeps no
recordings of its own, such as a Reolink camera or a stream. It needs
`ffmpeg` installed. Each picked camera's main stream is read from go2rtc,
so the camera serves one connection however many watch or record it, and
saved unchanged, video only, as 5-minute MP4 files in
`recordings/<source>/<camera>/<day>/` in the state folder, or a folder you
choose, such as a share on a NAS.

### Keeping recordings

Each hour the server clears out old recordings, its own and those copied
from sources alike:

| Setting           | Default       | What it keeps                                                       |
| ----------------- | ------------- | ------------------------------------------------------------------- |
| `continuousHours` | 168 (7 days)  | Footage recorded all the time, in files with no reason or `normal`  |
| `clipHours`       | 720 (30 days) | Clips recorded for a reason, such as motion or PIR                  |
| `diskShare`       | 10            | The most of its disk the recordings folder may use, as a percentage |

Past the share, whatever is furthest through its own hours goes first: a
clip a week into its 30 days goes before continuous footage an hour into
its 7, and footage 4 days into its 7 goes before that clip. 5% of the disk
is always left free. Copying from sources follows the same order, so it
never copies an old clip only to clear out newer footage for it. A file
written to in the last two minutes is left alone. Only folders with the
server's marker are touched, so a shared folder is safe.

Pick the cameras, folder and how long they're kept in the Recording panel
on the Settings page. They're saved in `sources.json` under `recording`,
beside the rest of the settings, so every client sees the same ones, and
the server picks up a change without restarting.

### Background work

Copying from sources and clearing out old recordings keep to limits, so
the server can share a small machine, such as a Home Assistant Green, with
everything else on it. Before each file, and while it copies, background
work waits while any of these is past its limit, and carries on after.
Clearing out waits at most 10 minutes, then runs anyway, as it frees the
disk. Live view and the server's own recording never wait.

| Setting       | Default | What it limits                                                                  |
| ------------- | ------- | ------------------------------------------------------------------------------- |
| `copyRate`    | 2       | How fast a copy reads from a source, in MB a second                             |
| `memoryFree`  | 15      | The share of the machine's memory kept free, as a percentage                    |
| `memoryLimit` | 512     | The most memory the server, go2rtc and ffmpeg may use together, in MB           |
| `cpuShare`    | 50      | The most of the machine's CPU they may use, as a percentage, over half a minute |

It also waits while the machine is short of memory or its disks are busy,
from Linux's pressure figures: something waiting for memory over 5% of the
time, which means it's swapping, or for the disks over 30%. Set the limits
in the Background work group of the Recording panel; they're saved under
`recording.limits`.

The Activity page shows each job, such as the copy and each camera's
recording, with what it's doing, how far through it is, its last run and
last error, the recordings copied lately, and what each camera's
recordings take on disk. It also shows the server's memory and CPU against
these limits and the machine's, with the last hour of each, and says why
background work is waiting when it is. `kestrel jobs` and `kestrel usage`
print the same.

After changing the server, restart it with `mise run serve:server:restart`.
If it doesn't come up without a saved login, `op run` may be waiting for
1Password to be unlocked.

## Settings

| Variable                   | Default                          | What it sets                                                        |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `KESTREL_HOST`             | `::`                             | The address the server listens on; `serve:server` sets `127.0.0.1`  |
| `KESTREL_PORT`             | `7380`                           | The server's port (`PORT` too, for Pitchfork)                       |
| `KESTREL_FTP_PORT`         | `7381`                           | The port cameras send their clips to, with data on 7390 to 7399     |
| `KESTREL_GO2RTC_PORT`      | `1984`                           | go2rtc's port                                                       |
| `KESTREL_GO2RTC_RTSP_PORT` | `1985`                           | go2rtc's RTSP port, on 127.0.0.1 only                               |
| `KESTREL_GO2RTC`           | `go2rtc`                         | The go2rtc binary; the desktop app uses its own                     |
| `KESTREL_FFMPEG`           | `ffmpeg`                         | The ffmpeg binary, for recording cameras and web pages              |
| `KESTREL_YT_DLP`           | `yt-dlp`                         | The yt-dlp binary, for web pages; the desktop app uses its own      |
| `KESTREL_NODE`             | `node`                           | The Node.js yt-dlp runs JavaScript on; the desktop app uses its own |
| `KESTREL_WEB`              | `packages/web/dist`              | The built web client; the desktop app uses its own                  |
| `KESTREL_CONFIG`           | `~/.config/kestrel`              | Where `sources.json` is kept                                        |
| `KESTREL_STATE`            | `~/.local/state/kestrel`         | Where paired devices, push subscriptions and recordings go          |
| `KESTREL_RECORDINGS`       | `recordings` in the state folder | Where the server's own recordings go                                |
| `KESTREL_NAME`             | The machine's name               | The name devices see the server by                                  |
| `KESTREL_URL`              | Its address on the network       | The address other devices reach it at, for pairing links            |
| `KESTREL_INGRESS_PORT`     | None                             | A port for Home Assistant's ingress, which the app sets             |
| `KESTREL_APP_OPTIONS`      | None                             | The Home Assistant app's options file, which the app sets           |
