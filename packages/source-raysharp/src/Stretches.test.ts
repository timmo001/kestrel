/**
 * Checks how a range splits into one download per file, which the recorder
 * gets wrong silently: a range ending where the next file starts sends that
 * file instead.
 */
import type { ChannelRecording } from "@timmo001/kestrel-protocol-raysharp";
import { expect, test } from "bun:test";
import { stretches } from "./Stretches.ts";

const recording = (begin: string, end: string): ChannelRecording => ({
  channel: 1,
  begin: `2026-11-11T${begin}`,
  end: `2026-11-11T${end}`,
  reasons: ["normal"],
  bytes: null,
});

const day = (time: string) => `2026-11-11T${time}`;

test("a range across back-to-back files stops a second short of each join", () => {
  const files = [
    recording("21:50:48", "21:59:13"),
    recording("21:42:22", "21:50:48"),
  ];

  expect(stretches(files, day("21:50:30"), day("21:51:10"))).toEqual([
    { begin: day("21:50:30"), end: day("21:50:47") },
    { begin: day("21:50:48"), end: day("21:51:10") },
  ]);

  // To the end of both: only the second file runs to its own end
  expect(stretches(files, day("21:42:22"), day("21:59:13"))).toEqual([
    { begin: day("21:42:22"), end: day("21:50:47") },
    { begin: day("21:50:48"), end: day("21:59:13") },
  ]);
});

test("a clip with a gap after it runs to its own end", () => {
  const files = [
    recording("17:36:29", "17:36:34"),
    recording("18:02:10", "18:02:40"),
  ];

  expect(stretches(files, day("17:30:00"), day("17:40:00"))).toEqual([
    { begin: day("17:36:29"), end: day("17:36:34") },
  ]);
});

test("a range ending on a join leaves the next file out", () => {
  const files = [
    recording("21:42:22", "21:50:48"),
    recording("21:50:48", "21:59:13"),
  ];

  expect(stretches(files, day("21:50:00"), day("21:50:48"))).toEqual([
    { begin: day("21:50:00"), end: day("21:50:47") },
  ]);
});
