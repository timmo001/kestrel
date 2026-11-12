/** Checks that a download's packs join into frames, in pieces and to the end. */
import { expect, test } from "bun:test";
import { concat, encodeFrame } from "./Codec.ts";
import { recordingDecoder } from "./Recorded.ts";

/** A 40-byte RSFm frame header and its data, padded to 8 bytes as the recorder sends it. */
const frameBytes = (kind: "I" | "P", time: number, data: Uint8Array) => {
  const bytes = new Uint8Array(40 + Math.ceil(data.length / 8) * 8);
  const fields = new DataView(bytes.buffer);

  bytes.set([0x52, 0x53, 0x46, 0x6d, kind.charCodeAt(0)], 0);
  fields.setUint32(12, data.length, true);
  fields.setBigUint64(16, BigInt(time), true);
  fields.setUint16(32, 1920, true);
  fields.setUint16(34, 1080, true);
  bytes[36] = 15;
  bytes.set(data, 40);

  return bytes;
};

/** A PackHead: version 0, no extension, then the pack's data. */
const pack = (
  type: number,
  options: { packs: number; frame: number; index: number; data: Uint8Array },
) => {
  const head = new Uint8Array(12);
  const fields = new DataView(head.buffer);

  head[1] = type;
  fields.setUint16(2, options.packs, true);
  fields.setUint32(4, options.frame, true);
  fields.setUint16(8, options.index, true);
  fields.setUint16(10, options.data.length, true);

  return concat(head, options.data);
};

/** The reply to the download request, unscrambled, with its ack. */
const reply = (ack: number) => {
  const bytes = encodeFrame({
    mode: 0,
    type: 131,
    subtype: 0,
    sequence: 1,
    body: new Uint8Array(0),
  });

  new DataView(bytes.buffer).setUint16(2, ack, true);

  return bytes;
};

test("packs split across chunks join into frames, up to the end of the file", () => {
  const key = Uint8Array.from({ length: 30 }, (_, index) => index);
  const delta = Uint8Array.of(9, 8, 7);
  const first = frameBytes("I", 1_000_000, key);

  const bytes = concat(
    reply(0),
    pack(0, { packs: 2, frame: 7, index: 0, data: first.subarray(0, 50) }),
    pack(0, { packs: 2, frame: 7, index: 1, data: first.subarray(50) }),
    pack(0, {
      packs: 1,
      frame: 8,
      index: 0,
      data: frameBytes("P", 1_066_667, delta),
    }),
    pack(3, { packs: 0, frame: 0, index: 0, data: new Uint8Array(0) }),
    // Anything after the end of the file is left alone
    pack(0, { packs: 1, frame: 9, index: 0, data: new Uint8Array(4) }),
  );

  const decode = recordingDecoder();

  const results = [3, 20, 61, 90, bytes.length].map((end, index, ends) =>
    decode(bytes.subarray(ends[index - 1] ?? 0, end)),
  );

  expect(results.flatMap((result) => result.frames)).toEqual([
    {
      key: true,
      time: 1_000_000,
      width: 1920,
      height: 1080,
      fps: 15,
      data: key,
    },
    {
      key: false,
      time: 1_066_667,
      width: 1920,
      height: 1080,
      fps: 15,
      data: delta,
    },
  ]);

  expect(results.at(-1)?.ended).toBe(true);
});

test("a refused download says why", () => {
  expect(recordingDecoder()(reply(50)).problem).toBe(
    "The recorder turned the request down: Not allowed for this user",
  );
});
