/** Checks which recording each channel plays at a moment, and where playback runs on to. */
import type { Recording } from "@timmo001/kestrel-rsnet/domain";
import { expect, test } from "bun:test";
import { momentAt, nextMoment, recordingAt, type Track } from "./moments.ts";
import { toSeconds } from "./player.ts";

const recording = (channel: number, begin: string, end: string): Recording => ({
  channel,
  begin: `2026-11-11T${begin}`,
  end: `2026-11-11T${end}`,
  reasons: ["normal"],
  bytes: null,
});

const at = (time: string) => toSeconds(`2026-11-11T${time}`);

// Channel 1 records all the time in back-to-back files; 3 only on motion
const tracks: ReadonlyArray<Track> = [
  {
    channel: 1,
    recordings: [
      recording(1, "10:00:00", "10:08:26"),
      recording(1, "10:08:26", "10:16:52"),
    ],
  },
  {
    channel: 3,
    recordings: [
      recording(3, "10:05:00", "10:06:00"),
      recording(3, "10:30:00", "10:31:00"),
    ],
  },
];

test("the picked channel keeps the time when it recorded then", () => {
  const moment = momentAt(tracks, 3, at("10:05:30"));

  expect(moment.driver).toBe(3);
  expect(moment.shown.map((one) => one.recording?.begin)).toEqual([
    "2026-11-11T10:00:00",
    "2026-11-11T10:05:00",
  ]);
});

test("another channel keeps the time when the picked one recorded nothing", () => {
  const moment = momentAt(tracks, 3, at("10:07:00"));

  expect(moment.driver).toBe(1);
  expect(moment.shown[1]?.recording).toBeUndefined();
});

test("with nothing recorded, playback runs on to the next start on any channel", () => {
  const gap = at("10:20:00");

  expect(momentAt(tracks, 1, gap).driver).toBeUndefined();
  expect(nextMoment(tracks, gap)).toBe(at("10:30:00"));
  expect(nextMoment(tracks, at("10:30:30"))).toBeUndefined();
});

test("where one file runs into the next, the join plays the later file", () => {
  const list = tracks[0]?.recordings ?? [];

  expect(recordingAt(list, at("10:08:26"))?.begin).toBe("2026-11-11T10:08:26");
  expect(recordingAt(list, at("10:08:25"))?.begin).toBe("2026-11-11T10:00:00");
});
