/** Checks which recording each camera plays at a moment, and where playback runs on to. */
import type { Recording } from "@timmo001/kestrel-core/domain";
import { expect, test } from "bun:test";
import { momentAt, nextMoment, recordingAt, type Track } from "./moments.ts";
import { toSeconds } from "./player.ts";

const recording = (camera: string, begin: string, end: string): Recording => ({
  camera,
  begin: `2026-11-11T${begin}`,
  end: `2026-11-11T${end}`,
  reasons: ["normal"],
  bytes: null,
});

const at = (time: string) => toSeconds(`2026-11-11T${time}`);

// Camera 1 records all the time in back-to-back files; 3 only on motion
const tracks: ReadonlyArray<Track> = [
  {
    camera: "swann/1",
    recordings: [
      recording("swann/1", "10:00:00", "10:08:26"),
      recording("swann/1", "10:08:26", "10:16:52"),
    ],
  },
  {
    camera: "swann/3",
    recordings: [
      recording("swann/3", "10:05:00", "10:06:00"),
      recording("swann/3", "10:30:00", "10:31:00"),
    ],
  },
];

test("the picked camera keeps the time when it recorded then", () => {
  const moment = momentAt(tracks, "swann/3", at("10:05:30"));

  expect(moment.driver).toBe("swann/3");
  expect(moment.shown.map((one) => one.recording?.begin)).toEqual([
    "2026-11-11T10:00:00",
    "2026-11-11T10:05:00",
  ]);
});

test("another camera keeps the time when the picked one recorded nothing", () => {
  const moment = momentAt(tracks, "swann/3", at("10:07:00"));

  expect(moment.driver).toBe("swann/1");
  expect(moment.shown[1]?.recording).toBeUndefined();
});

test("with nothing recorded, playback runs on to the next start on any camera", () => {
  const gap = at("10:20:00");

  expect(momentAt(tracks, "swann/1", gap).driver).toBeUndefined();
  expect(nextMoment(tracks, gap)).toBe(at("10:30:00"));
  expect(nextMoment(tracks, at("10:30:30"))).toBeUndefined();
});

test("where one file runs into the next, the join plays the later file", () => {
  const list = tracks[0]?.recordings ?? [];

  expect(recordingAt(list, at("10:08:26"))?.begin).toBe("2026-11-11T10:08:26");
  expect(recordingAt(list, at("10:08:25"))?.begin).toBe("2026-11-11T10:00:00");
});
