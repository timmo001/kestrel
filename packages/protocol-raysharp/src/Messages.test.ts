/** Checks the colour page's envelope and offsets against a reply from a DVR8-4575 on SRV7.1.0. */
import { expect, test } from "bun:test";
import {
  channelParamRequest,
  colourSave,
  parseColourPage,
} from "./Messages.ts";

const u32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  value >>> 24,
];

/** One 96-byte colour entry, as channel `channel` replied. */
const entry = (channel: number, values: ReadonlyArray<number>) => [
  ...u32(96),
  ...u32(1 << (channel - 1)),
  ...values,
  ...Array.from({ length: 96 - 8 - values.length }, () => 0),
];

/** A page reply: its size, an empty struct, then the list. */
const page = (entries: ReadonlyArray<ReadonlyArray<number>>) => {
  const list = entries.flatMap((each) => [...u32(each.length), ...each]);

  return Uint8Array.from([
    ...u32(8 + list.length),
    ...u32(4),
    ...u32(list.length),
    ...list,
  ]);
};

// Hue, brightness, contrast, saturation, defaults, sharpness, bits
const channel1 = entry(1, [0x7e, 0x82, 0x72, 0x94, 0, 0x40, 0x41]);
const channel2 = entry(2, [0x7d, 0x88, 0x84, 0x8a, 0, 0x40, 0x41]);

test("a request names its channels in the mask inside the element", () => {
  expect(Array.from(channelParamRequest([1]))).toEqual([
    ...u32(36),
    ...u32(36),
    ...u32(1),
    ...Array.from({ length: 28 }, () => 0),
  ]);

  expect(
    Array.from(channelParamRequest([1, 2, 32, 34]).subarray(8, 16)),
  ).toEqual([...u32(0x80000003), ...u32(2)]);
});

test("the colour page reads each channel's entry", () => {
  const read = parseColourPage(page([channel1, channel2]));

  expect(read).toMatchObject([
    {
      channel: 1,
      hue: 126,
      brightness: 130,
      contrast: 114,
      saturation: 148,
      sharpness: 64,
      range: 255,
      resettable: true,
    },
    {
      channel: 2,
      hue: 125,
      brightness: 136,
      contrast: 132,
      saturation: 138,
      sharpness: 64,
      range: 255,
      resettable: true,
    },
  ]);
});

test("an empty page reads as no channels", () => {
  expect(
    parseColourPage(Uint8Array.from([8, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0])),
  ).toEqual([]);
});

test("a save sends the entry back with only the change in place", () => {
  const [colour] = parseColourPage(page([channel1]));

  if (colour === undefined) throw new Error("No channel 1");

  const changed = [...channel1];
  changed[9] = 131;
  changed[13] = 255;

  expect(
    Array.from(colourSave(colour, { brightness: 131, sharpness: 300 })),
  ).toEqual(Array.from(page([changed])));

  const defaults = [...channel1];
  defaults[12] = 1;

  expect(Array.from(colourSave(colour, "defaults"))).toEqual(
    Array.from(page([defaults])),
  );
});
