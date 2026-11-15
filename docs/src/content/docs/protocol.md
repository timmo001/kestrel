---
title: Protocol
description: What Kestrel speaks to each kind of device, from the Raysharp recorders' control protocol and Reolink's own protocol to a Bambu Lab printer's camera feed and the FTP receiver for clips cameras send.
---

Kestrel talks to each kind of device in its own way. Streams, web pages
and Reolink's live video go through go2rtc; everything else is here. The
Raysharp recorders' protocol comes first, then
[Reolink's](#reolink-baichuan), a [Bambu Lab printer's](#bambu-lab-printers)
and the [FTP receiver](#the-ftp-receiver) cameras send their clips to.

## Raysharp recorders

Raysharp recorders take control messages on TCP port 9000.
`packages/protocol-raysharp` follows the message numbers and layouts in the
vendor SDK's protocol header, and the notes here say where firmware SRV7.1.0
differs. The mode 2 scrambling and the recorded video's frame header were
worked out by reverse engineering, and everything is checked against a real
recorder.

### Framing

Every message has a 16-byte header: the protocol mode, an ack code, the
message type and subtype, the body's size and a sequence number, all
little-endian. Replies carry the request's sequence number. In mode 2, which
these recorders use, everything after the first two header bytes, and the
body, is scrambled with a fixed bit permutation that needs no key.

### Messages used

| Type | Subtype | What it does                                            |
| ---- | ------- | ------------------------------------------------------- |
| 31   | 0       | Log in with the username and password in 36-byte fields |
| 32   | 0       | Heartbeat, every 5 seconds                              |
| 890  | 614     | Status: clock, disks and each channel's state           |
| 111  | 101     | Recordings on one channel between two times             |
| 111  | 102     | Days with recordings on a set of channels               |
| 131  | 0       | Download a stretch of recording, on its own connection  |
| 121  | 0       | Play recordings, on its own connection                  |
| 122  | 121     | Ask a playback for more data                            |
| 124  | step    | Key frames only, one per `step` seconds of recording    |
| 896  | 196     | Subscribe to alarm reports                              |
| 891  | various | Alarm reports, sent by the recorder once subscribed     |
| 211  | 508     | Each channel's colour: hue, brightness and the rest     |
| 216  | 508     | Save a channel's colour, or put back its defaults       |

### Differences on SRV7.1.0

- Status subtype 610 replies blank, so the client asks for 614, which fills
  the same layout. Both reply with ack 1 even when they hold good data.
- The day outline's time of day is junk; only the date is reliable.
- Model and serial come back empty in the login reply.
- A parameter page request without its size in front gets an empty page.
- 217, which should read a page's defaults, replies with every value 0, so
  the client puts the colour back by saving with its defaults byte set.

### Downloads

The recorder has no RTSP address for recordings, so recorded video comes
through the download message, 131. It goes on a second connection with no
login of its own: the 24-byte request carries the user key from the main
connection's login reply, the channel from 0 and the stream (0 main, 1 sub).
One 28-byte record follows, of the kind a search returns, with the range.

The reply is an empty ack, then packs: a 12-byte header (its version, type,
how many packs the frame takes, the frame's number, the pack's number and its
size), then a piece of a frame. Type 0 is a frame piece, and type 3 marks the
end of the file. Each frame starts with a 40-byte header the SDK doesn't
describe:

| Offset | Size | What it is                                       |
| ------ | ---- | ------------------------------------------------ |
| 0      | 4    | `RSFm`                                           |
| 4      | 1    | `I` for a key frame, `P` for the rest            |
| 12     | 4    | The size of the H.264 data that follows          |
| 16     | 8    | The recorder's clock in microseconds, local time |
| 32     | 2    | Width                                            |
| 34     | 2    | Height                                           |
| 36     | 1    | Frames per second                                |

The H.264 is in Annex B form, padded to a multiple of 8 bytes, and key frames
carry their SPS, PPS and SEI. On the DVR8-4575 the main stream is 1920×1080
at 15 frames a second with a key frame each second; the sub stream is 352×288
at about 4.

The range can be any stretch inside a file, and the record can say "all
types, size unknown". SRV7.1.0 handles ranges in its own way:

- It sends only the first record, though the SDK allows several in a request,
  so a range across files takes a request for each.
- It picks the file by the range's end. Where one file runs straight into the
  next, a range ending on the join gets the next file, from that file's start.
  The client ends those ranges a second early; the last key frame group still
  runs to the file's end.

### Fast forward

Playback, message 121, takes a 68-byte request on its own connection: the
user key, the channel from 0, the type (all), the begin and end times at 12
and 20, and the stream at 28. The recorder sends data as the client asks for
it with 122/121, in the same packs as a download's. SRV7.1.0 ignores the end
and plays to the end of the file, where pack type 2 marks the end of the
recording, so the client stops at the end itself and asks for each file in
turn.

The play control message, 124, carries its setting in the subtype. On
SRV7.1.0 a subtype from 1 up is a step in seconds: the recorder then sends
only key frames, one per step of recording. With a step of 1 that's every key
frame of the main stream, at about 58 times real time where the whole stream
downloads at about 17, which is how the page plays past 16 times in full
resolution. Message 404, the SDK's key frame request, gets no answer.

The recorder runs one playback or download at a time. Another one meanwhile
is turned down with ack 322, and the recorder lets go of the last one a few
seconds after its connection closes.

### Alarm reports

Motion (191), PIR (187), video loss (189) and alarm input (192) reports start
with the channel from 0, a status (1 on, 0 off) and the time. Recording status
(212) and disk (202, 213) reports put those fields elsewhere. These layouts
come from the SDK header and are checked in real use.

### Picture colour

The recorder keeps settings on parameter pages, read with 211 and saved with
216, the subtype naming the page. Each message is an element: its size, not
counting the size itself, then a struct starting with its own size. A read
asks with a 36-byte struct, its size then a 256-bit mask of the channels
wanted. A reply, and a save, follow the struct with a list: its size, then
each channel's entry with its size in front.

The colour page is 508. Its 96-byte entries give the channel's mask, then a
byte each for hue, brightness, contrast and saturation, a byte that asks for
the defaults back, sharpness, and a byte of bits: the range in the lowest two
(0 for 0 to 63, 1 for 0 to 255) and whether to offer the defaults in bit 6.
Gamma, a second set of values and two times follow, which a save sends back
as they were. A save takes effect at once, and replies with an empty ack.
These layouts come from the SDK's sources and are checked against a
DVR8-4575.

## Reolink (Baichuan)

Reolink cameras, hubs and recorders serve an HTTP API at
`/cgi-bin/api.cgi`, which the source uses for nearly everything, following
the open-source reolink_aio client. Two things go over Reolink's own
protocol on TCP port 9000, known as Baichuan, which
`packages/protocol-baichuan` speaks after the open-source reolink_aio,
neolink and nodelink-js clients: replaying a hub or recorder's files, which
its HTTP API can't always hand over, and live video for recording, since
some cameras' RTSP main stream weaves in frames from the sub stream.

### Framing

Every message starts with `f0 de bc 0a`, then, little-endian, the command
(4 bytes), the body's size (4), the channel (1), the stream (1, 0 for main
and 1 for sub), a message number (2), a status (2) and the message class
(2). The long classes add a fourth word, where the payload starts in the
body; what comes before it is extension XML.

| Class    | Header   | Where it's used          |
| -------- | -------- | ------------------------ |
| `0x6514` | 20 bytes | The first login message  |
| `0x6614` | 20 bytes | Replies                  |
| `0x6414` | 24 bytes | Requests after the first |
| `0x0000` | 24 bytes | Replies and media        |
| `0x6482` | 24 bytes | File downloads           |

The status is 200 when a request is done, 400 when it's refused, and 0 on
media. The channel is 250 for the device itself, the camera's channel for
live video, or a handle of the replay's own, from 40 to 239, as the Reolink
app does. Replies take up to 20 seconds, and a body past 16 MB is taken as
the connection being out of step.

### Login and encryption

Until login, XML is scrambled with a fixed 8-byte XOR key, stepped by the
channel byte and XORed with it too, which undoes itself. Login takes two
messages:

1. Command 1 with no body, on class `0x6514` with status `0xdc12`. The
   reply carries a `<nonce>`.
2. Command 1 again, with `LoginUser` XML whose user name and password are
   each the MD5 of the value and the nonce run together, as the first 31
   hex digits in capitals. Status 200 means it's in.

After that, XML is AES-128-CFB, with the fixed IV `0123456789abcdef` and a
fresh cipher for each message. Its key is the first 16 characters of the
same MD5 of the nonce, a dash and the password. Media messages say in
their extension's `encryptLen` how many bytes at the start of the payload
are encrypted; the rest are plain. Command 2 logs out as the connection
closes.

### Replay and live video

| Command | What it does     |
| ------- | ---------------- |
| 1       | Log in           |
| 2       | Log out          |
| 3       | Start live video |
| 4       | Stop live video  |
| 5       | Replay a file    |
| 7       | Stop a replay    |

A replay asks for one file by its full path, as the HTTP `Search` names it,
in a `FileInfoList` with the channel from 0 and the stream. Nothing marks
the end, so a 3-second pause ends it, or status 201 where firmware sends
one. Stopping it names the file by its channel from 1, as two digits, and
the date and time in its name. Older camera firmware refuses a replay, and
a camera cuts a download short, so only a hub or recorder's files are
copied this way.

Live video asks with a `Preview` naming the channel, a handle (0 for the
main stream and 256 for the sub, as the official client does, neolink
found) and the stream. It has no end, so 10 seconds with nothing means the
device has stopped sending. The source hands it to go2rtc as an MPEG
transport stream, timed by the camera's own clock.

### The media stream

Replays and live video carry the same stream, read as it comes, so a whole
file is never held at once. Each piece starts with a 4-character tag:

| Tag            | What follows                                                    |
| -------------- | --------------------------------------------------------------- |
| `1001`, `1002` | The stream's header, 32 bytes in all                            |
| `00dc`, `01dc` | A key frame or another frame: a 24-byte header, then the frame  |
| `05wb`, `01wb` | Audio: an 8-byte header with its size at 4, which Kestrel skips |

A video frame's header has the codec at 4 (`H264` or `H265`), the frame's
size at 8, the size of extra data before it at 12, and the device's
microsecond counter at 16, which wraps every 71 minutes. The frame is
Annex B with start codes, and every piece is padded to 8 bytes. Devices
sometimes send a frame twice, so a repeat is dropped, and anything with no
tag Kestrel knows is skipped to the next one. Frames go into an MP4 as they
were recorded, H.265 included.

## Bambu Lab printers

Bambu Lab P1 and A1 printers have no video stream on the network, only a
camera feed over TLS on port 6000, read as the open-source ha-bambulab
client does. The printer's certificate is its own, so it isn't checked.

The feed opens with an 80-byte login: four little-endian words (`0x40`,
`0x3000`, 0 and 0), then the user `bblp` and the LAN access code, each
padded to 32 bytes. The printer then sends a JPEG every second or two,
each after a 16-byte header that starts with its size, little-endian. A
size past 8 MB, or a picture that isn't a JPEG, means the feed is out of
step.

Its recordings come from its storage over implicit FTPS on port 990,
logged in as `bblp` with the same access code, a connection each time.
`/ipcam` holds what the camera records during prints, as
`ipcam-record.<date>_<hh>-<mm>-<ss>.<n>.avi`, and `/timelapse` each
print's timelapse, as `video_<date>_<hh>-<mm>-<ss>.avi`, both by the
printer's own clock. They're MJPEG, so each is converted to H.264 with
ffmpeg as it's copied or played.

## The FTP receiver

Cameras that send their clips by FTP, such as a Reolink camera with
**Send clips to Kestrel** on, send them to an upload-only receiver in
`packages/protocol-ftp`, on `KESTREL_FTP_PORT` (7381 by default) and the
address the server listens on. It's plain FTP: `AUTH` is turned down.

- Each source has its own login, which the server makes and keeps in
  `uploads.json` in the state folder, and checks in constant time.
- Data goes over passive connections only, `PASV` or `EPSV`, on the ten
  ports from 7390, and a data connection must come from the same address
  as its login. `PASV` only answers on IPv4; on IPv6 the camera uses
  `EPSV`.
- `STOR` and `APPE` hand the file over as it arrives. The reply is 226 once
  it's kept, or 451 when it isn't.
- It lists nothing and hands nothing back: listings come back empty,
  `RETR`, `SIZE` and `MDTM` return 550, folders exist as soon as they're
  named, and `DELE` and `RMD` say they're done, since nothing is kept to
  delete.
- A connection quiet for 5 minutes is closed, a camera has 30 seconds to
  open the data connection it asked for, and one file may take an hour.

A Reolink camera is pointed at it with `SetFtp`: the server by its DNS name
where the network has one, else its address, the port, the login, the
folder `kestrel`, and its schedule on. Turning it off sets the schedule
off and leaves the rest. Where `GetAbility` says the camera has
`ftpTest`, `TestFtp` checks the connection; older firmware answers that
without trying, so it isn't asked. Each clip's start comes from the time
in its name, such as `Front Door_01_20260713123456.mp4`, and anything that
isn't an MP4 named with a time is read and dropped.
