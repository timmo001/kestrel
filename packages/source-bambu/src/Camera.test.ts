/** Tests for reading pictures out of a Bambu Lab printer's camera feed. */
import { expect, test } from "bun:test";
import { loginPacket, pictureReader } from "./Camera.ts";

const jpeg = (size: number) => {
  const picture = new Uint8Array(size).fill(0x11);

  picture.set([0xff, 0xd8, 0xff, 0xe0]);
  picture.set([0xff, 0xd9], size - 2);

  return picture;
};

const framed = (picture: Uint8Array) => {
  const frame = new Uint8Array(16 + picture.length);

  new DataView(frame.buffer).setUint32(0, picture.length, true);
  frame.set(picture, 16);

  return frame;
};

test("reads pictures split across chunks and joined in one", () => {
  const read = pictureReader();
  const first = framed(jpeg(100));
  const second = framed(jpeg(40));
  const stream = new Uint8Array(first.length + second.length);

  stream.set(first);
  stream.set(second, first.length);

  expect(read(stream.subarray(0, 16)).pictures).toHaveLength(0);
  expect(read(stream.subarray(16, 70)).pictures).toHaveLength(0);

  const rest = read(stream.subarray(70));

  expect(rest.problem).toBeNull();
  expect(rest.pictures.map((picture) => picture.length)).toEqual([100, 40]);
});

test("stops at a picture that isn't a JPEG", () => {
  const read = pictureReader();

  expect(read(framed(new Uint8Array(20))).problem).toContain("isn't a JPEG");
});

test("puts the username and access code in their places", () => {
  const packet = loginPacket("12345678");

  expect(packet).toHaveLength(80);
  expect(Array.from(packet.subarray(0, 8))).toEqual([
    0x40, 0, 0, 0, 0, 0x30, 0, 0,
  ]);
  expect(new TextDecoder().decode(packet.subarray(16, 20))).toBe("bblp");
  expect(new TextDecoder().decode(packet.subarray(48, 56))).toBe("12345678");
  expect(packet[56]).toBe(0);
});
