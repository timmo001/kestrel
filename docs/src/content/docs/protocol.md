---
title: Protocol
description: What the recorder's control protocol looks like, as packages/rsnet speaks it.
---

Raysharp recorders take control messages on TCP port 9000. `packages/rsnet`
follows the message numbers and layouts in the vendor SDK's protocol header,
and the notes here say where firmware SRV7.1.0 differs.

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
| 896  | 196     | Subscribe to alarm reports                              |
| 891  | various | Alarm reports, sent by the recorder once subscribed     |

## Differences on SRV7.1.0

- Status subtype 610 replies blank, so the client asks for 614, which fills
  the same layout. Both reply with ack 1 even when they hold good data.
- The day outline's time of day is junk; only the date is reliable.
- Model and serial come back empty in the login reply.

## Alarm reports

Motion (191), PIR (187), video loss (189) and alarm input (192) reports start
with the channel from 0, a status (1 on, 0 off) and the time. Recording status
(212) and disk (202, 213) reports put those fields elsewhere. These layouts
come from the SDK header and are checked in real use.
