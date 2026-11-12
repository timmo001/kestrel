---
title: Protocol
description: What the recorder's control protocol looks like, as packages/protocol-raysharp speaks it.
---

Raysharp recorders take control messages on TCP port 9000.
`packages/protocol-raysharp` follows the message numbers and layouts in the
vendor SDK's protocol header, and the notes here say where firmware SRV7.1.0
differs. The mode 2 scrambling and the recorded video's frame header were
worked out by reverse engineering, and everything is checked against a real
recorder.

## Framing

Every message has a 16-byte header: the protocol mode, an ack code, the
message type and subtype, the body's size and a sequence number, all
little-endian. Replies carry the request's sequence number. In mode 2, which
these recorders use, everything after the first two header bytes, and the
body, is scrambled with a fixed bit permutation that needs no key.

## Messages used

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

## Differences on SRV7.1.0

- Status subtype 610 replies blank, so the client asks for 614, which fills
  the same layout. Both reply with ack 1 even when they hold good data.
- The day outline's time of day is junk; only the date is reliable.
- Model and serial come back empty in the login reply.

## Downloads

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

## Fast forward

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

## Alarm reports

Motion (191), PIR (187), video loss (189) and alarm input (192) reports start
with the channel from 0, a status (1 on, 0 off) and the time. Recording status
(212) and disk (202, 213) reports put those fields elsewhere. These layouts
come from the SDK header and are checked in real use.
