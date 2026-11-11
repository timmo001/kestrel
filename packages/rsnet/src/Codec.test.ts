/** Checks the scrambling and frame splitting, which fail silently when wrong. */
import { expect, test } from "bun:test";
import { encodeFrame, frameDecoder, permute } from "./Codec.ts";

test("permute round-trips any length", () => {
  for (const length of [1, 2, 7, 16, 80, 1232]) {
    const input = Uint8Array.from(
      { length },
      (_, index) => (index * 37 + 11) & 0xff,
    );

    expect(permute(permute(input), true)).toEqual(input);
  }
});

test("a scrambled frame decodes back when it arrives in pieces", () => {
  const body = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff);

  const bytes = encodeFrame({
    mode: 2,
    type: 111,
    subtype: 101,
    sequence: 42,
    body,
  });

  const chunks = [5, 17, 200, bytes.length].map((end, index, ends) =>
    bytes.subarray(ends[index - 1] ?? 0, end),
  );

  const decode = frameDecoder();
  const frames = chunks.flatMap((chunk) => decode(chunk).frames);

  expect(frames).toEqual([
    { mode: 2, ack: 0, type: 111, subtype: 101, sequence: 42, body },
  ]);
});

test("a body larger than the limit stops decoding", () => {
  const decode = frameDecoder();

  const header = encodeFrame({
    mode: 0,
    type: 1,
    subtype: 0,
    sequence: 1,
    body: new Uint8Array(0),
  });

  new DataView(header.buffer).setUint32(8, 64 * 1024 * 1024, true);
  expect(decode(header).problem).toBe("Reply too large (67108864 bytes)");
});
