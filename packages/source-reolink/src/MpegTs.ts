/**
 * A minimal MPEG transport stream writer for one video track, as go2rtc and
 * ffmpeg read it: each frame is one PES packet with its presentation time,
 * and the program tables come before each key frame so a reader can start
 * there. Follows ISO/IEC 13818-1.
 *
 * @module
 */

const packetSize = 188;
const patPid = 0x0000;
const pmtPid = 0x1000;
const videoPid = 0x0100;

/** A transport stream's 33-bit clock runs at 90 kHz. */
export const clockRate = 90_000;

const clockWrap = 2 ** 33;

const streamTypes = { H264: 0x1b, H265: 0x24 } as const;

/** The MPEG-2 CRC-32: polynomial 0x04C11DB7, not reflected, starting at all ones. */
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;

  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }

  return crc >>> 0;
});

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = ((crc << 8) ^ (crcTable[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }

  return crc;
};

/** A table section with its CRC on the end. */
const section = (body: ReadonlyArray<number>) => {
  const bytes = new Uint8Array(body.length + 4);

  bytes.set(body);
  new DataView(bytes.buffer).setUint32(
    body.length,
    crc32(bytes.subarray(0, body.length)),
  );

  return bytes;
};

const pat = section([
  0x00,
  0xb0,
  13,
  0x00,
  0x01,
  0xc1,
  0x00,
  0x00,
  0x00,
  0x01,
  0xe0 | (pmtPid >> 8),
  pmtPid & 0xff,
]);

const pmt = (streamType: number) =>
  section([
    0x02,
    0xb0,
    18,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0xe0 | (videoPid >> 8),
    videoPid & 0xff,
    0xf0,
    0x00,
    streamType,
    0xe0 | (videoPid >> 8),
    videoPid & 0xff,
    0xf0,
    0x00,
  ]);

/** A 33-bit time in the 5-byte form a PES header carries it. */
const timeField = (time: number) => [
  0x21 | (Math.floor(time / 2 ** 29) & 0x0e),
  Math.floor(time / 2 ** 22) & 0xff,
  (Math.floor(time / 2 ** 14) & 0xfe) | 1,
  Math.floor(time / 2 ** 7) & 0xff,
  ((time % 128) << 1) | 1,
];

/** A 33-bit program clock, with no 27 MHz extension, in its 6-byte form. */
const pcrField = (time: number) => [
  Math.floor(time / 2 ** 25) & 0xff,
  Math.floor(time / 2 ** 17) & 0xff,
  Math.floor(time / 2 ** 9) & 0xff,
  Math.floor(time / 2) & 0xff,
  ((time % 2) << 7) | 0x7e,
  0x00,
];

export interface TsFrame {
  readonly key: boolean;
  /** When to show it, at 90 kHz; it wraps at 2^33. */
  readonly time: number;
  /** The frame in Annex B form, with start codes. */
  readonly data: Uint8Array;
}

/** Writes one video track, H.264 or H.265, a frame at a time. */
export const writer = (codec: keyof typeof streamTypes) => {
  const counters = new Map<number, number>();
  const tables = [pat, pmt(streamTypes[codec])] as const;

  const counter = (pid: number) => {
    const count = counters.get(pid) ?? 0;

    counters.set(pid, (count + 1) % 16);

    return count;
  };

  /** A table in one packet, the rest of it filled. */
  const tablePacket = (pid: number, table: Uint8Array) => {
    const packet = new Uint8Array(packetSize).fill(0xff);

    packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10 | counter(pid), 0]);
    packet.set(table, 5);

    return packet;
  };

  /** A PES packet cut into transport packets, the first carrying the clock. */
  const pesPackets = (pes: Uint8Array, key: boolean, clock: number) => {
    const packets: Array<Uint8Array> = [];
    let at = 0;

    do {
      const first = at === 0;
      const packet = new Uint8Array(packetSize).fill(0xff);
      const flags = first ? (key ? 0x50 : 0x10) : 0;
      // The adaptation field's length past its length byte, at its least: -1 for none
      const least = first ? 7 : -1;
      const room = packetSize - 4 - (least === -1 ? 0 : 1 + least);
      const left = pes.length - at;
      const adaptation = left >= room ? least : packetSize - 5 - left;

      packet.set([
        0x47,
        (first ? 0x40 : 0) | (videoPid >> 8),
        videoPid & 0xff,
        (adaptation === -1 ? 0x10 : 0x30) | counter(videoPid),
      ]);

      let from = 4;

      if (adaptation !== -1) {
        packet[4] = adaptation;

        if (adaptation > 0) {
          packet[5] = flags;

          if (first) packet.set(pcrField(clock), 6);
        }

        from = 5 + adaptation;
      }

      const take = packetSize - from;

      packet.set(pes.subarray(at, at + take), from);
      packets.push(packet);
      at += take;
    } while (at < pes.length);

    return packets;
  };

  return (frame: TsFrame) => {
    const time = frame.time % clockWrap;
    // Its own length left as 0, as video's may be, since a frame can pass 64 KB
    const header = [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...timeField(time)];
    const pes = new Uint8Array(header.length + frame.data.length);

    pes.set(header);
    pes.set(frame.data, header.length);

    // The clock runs a little behind, so a frame is never due before it arrives
    const clock = (time - clockRate / 10 + clockWrap) % clockWrap;

    const packets = [
      ...(frame.key
        ? tables.map((table, index) =>
            tablePacket(index === 0 ? patPid : pmtPid, table),
          )
        : []),
      ...pesPackets(pes, frame.key, clock),
    ];

    const bytes = new Uint8Array(packets.length * packetSize);

    packets.forEach((packet, index) => bytes.set(packet, index * packetSize));

    return bytes;
  };
};
