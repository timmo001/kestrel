/** Checks that a media stream read in pieces gives the frames it holds whole. */
import { expect, test } from "bun:test";
import { concat } from "./Codec.ts";
import { decoder, type MediaFrame } from "./Media.ts";

const ascii = (text: string) => new TextEncoder().encode(text);

const padded = (length: number) => length + ((8 - (length % 8)) % 8);

const header = () => {
  const bytes = new Uint8Array(32);

  bytes.set(ascii("1001"));

  return bytes;
};

const video = (key: boolean, microseconds: number, data: Uint8Array) => {
  const bytes = new Uint8Array(24 + padded(data.length));
  const fields = new DataView(bytes.buffer);

  bytes.set(ascii(key ? "00dcH265" : "01dcH265"));
  fields.setUint32(8, data.length, true);
  fields.setUint32(16, microseconds, true);
  bytes.set(data, 24);

  return bytes;
};

const audio = (length: number) => {
  const bytes = new Uint8Array(8 + padded(length));

  bytes.set(ascii("05wb"));
  new DataView(bytes.buffer).setUint16(4, length, true);

  return bytes;
};

const filled = (length: number, value: number) =>
  new Uint8Array(length).fill(value);

const stream = concat(
  header(),
  video(true, 1000, filled(37, 1)),
  audio(13),
  // Junk it skips to the next frame
  filled(11, 9),
  video(false, 67_000, filled(20, 2)),
  // The same frame again, which it drops
  video(false, 67_000, filled(20, 2)),
  video(false, 133_000, filled(64, 3)),
);

const read = (size: number) => {
  const reading = decoder();
  const frames: Array<MediaFrame> = [];

  for (let at = 0; at < stream.length; at += size) {
    frames.push(...reading.push(stream.subarray(at, at + size)));
  }

  frames.push(...reading.end());

  return {
    codec: reading.codec(),
    frames: frames.map((frame) => ({
      key: frame.key,
      microseconds: frame.microseconds,
      data: [...frame.data],
    })),
  };
};

test("reads every frame, whatever pieces it comes in", () => {
  const whole = read(stream.length);

  expect(whole.codec).toBe("H265");
  expect(whole.frames.map((frame) => frame.microseconds)).toEqual([
    1000, 67_000, 133_000,
  ]);
  expect(whole.frames[0]?.key).toBe(true);
  expect(whole.frames[2]?.data).toEqual([...filled(64, 3)]);

  for (let size = 1; size < stream.length; size++) {
    expect(read(size)).toEqual(whole);
  }
});
