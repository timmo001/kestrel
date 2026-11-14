/**
 * What plays at a moment when several cameras play together: each
 * camera's recording at that time, if it has one, which camera's video
 * keeps the time, the next moment any of them recorded, and the stretches
 * around their events. Plain functions with no page in them, so they can be
 * tested.
 */
import type { CameraId, Recording } from "@timmo001/kestrel-core";
import { toSeconds } from "./recording-player.ts";

/** A camera and its day's recordings, earliest first. */
export interface Track {
  readonly camera: CameraId;
  readonly recordings: ReadonlyArray<Recording>;
}

/** What one camera shows at a moment: its recording then, or nothing. */
export interface Shown {
  readonly camera: CameraId;
  readonly recording: Recording | undefined;
}

export interface Moment {
  readonly shown: ReadonlyArray<Shown>;
  /** The camera whose video keeps the time, when any recorded then. */
  readonly driver: CameraId | undefined;
}

/**
 * A camera's recording at `at`, in recorder seconds. Where one file runs
 * straight into the next, the join belongs to the later one.
 */
export const recordingAt = (recordings: ReadonlyArray<Recording>, at: number) =>
  recordings.findLast(
    (recording) =>
      toSeconds(recording.begin) <= at && at < toSeconds(recording.end),
  );

/**
 * What each camera shows at `at`, and which keeps the time: the picked
 * camera when it recorded then, or else the first that did, in order.
 */
export const momentAt = (
  tracks: ReadonlyArray<Track>,
  picked: CameraId,
  at: number,
): Moment => {
  const shown = tracks.map((track) => ({
    camera: track.camera,
    recording: recordingAt(track.recordings, at),
  }));

  const driver =
    shown.find((one) => one.camera === picked && one.recording !== undefined) ??
    shown.find((one) => one.recording !== undefined);

  return { shown, driver: driver?.camera };
};

/** The first moment after `at` that any camera starts a recording, if there's one. */
export const nextMoment = (tracks: ReadonlyArray<Track>, at: number) => {
  const starts = tracks.flatMap((track) =>
    track.recordings.flatMap((recording) => {
      const begin = toSeconds(recording.begin);

      return begin > at ? [begin] : [];
    }),
  );

  return starts.length === 0 ? undefined : Math.min(...starts);
};

/** A stretch of recorder seconds, from `start` up to `end`. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** What makes a recording an event: something set it off, rather than a schedule. */
const isEvent = (recording: Recording) =>
  recording.reasons.some(
    (reason) =>
      reason === "motion" ||
      reason === "PIR" ||
      reason === "alarm" ||
      reason === "alarm input",
  );

/** Whether any camera recorded at `at`. */
const covered = (tracks: ReadonlyArray<Track>, at: number) =>
  tracks.some((track) => recordingAt(track.recordings, at) !== undefined);

/**
 * The stretches worth watching: every event on any camera, with up to
 * `before` seconds ahead of it and `after` after it, where some camera
 * recorded then, as one recording all the time has. Those that meet are
 * joined, earliest first.
 */
export const eventSpans = (
  tracks: ReadonlyArray<Track>,
  before = 20,
  after = 10,
): ReadonlyArray<Span> => {
  const events = tracks
    .flatMap((track) => track.recordings.filter(isEvent))
    .map((recording) => {
      let start = toSeconds(recording.begin);
      let end = toSeconds(recording.end);
      const earliest = start - before;
      const latest = end + after;

      while (start > earliest && covered(tracks, start - 1)) start--;

      while (end < latest && covered(tracks, end)) end++;

      return { start, end };
    })
    .toSorted((a, b) => a.start - b.start);

  return events.reduce<Array<Span>>((joined, span) => {
    const last = joined.at(-1);

    if (last !== undefined && span.start <= last.end) {
      joined[joined.length - 1] = {
        start: last.start,
        end: Math.max(last.end, span.end),
      };
    } else {
      joined.push(span);
    }

    return joined;
  }, []);
};

/** The span `at` falls in, if any. */
export const spanAt = (spans: ReadonlyArray<Span>, at: number) =>
  spans.find((span) => span.start <= at && at < span.end);

/** The first span starting after `at`. */
export const nextSpan = (spans: ReadonlyArray<Span>, at: number) =>
  spans.find((span) => span.start > at);

/**
 * The span to go back to from `at`: the start of the one it's in, once
 * a few seconds in, as a player's previous goes, else the one before.
 */
export const previousSpan = (spans: ReadonlyArray<Span>, at: number) =>
  spans.findLast((span) => span.start < at - 3);

/** The last moment before `at` that any camera started a recording, if there's one. */
export const previousMoment = (tracks: ReadonlyArray<Track>, at: number) => {
  const starts = tracks.flatMap((track) =>
    track.recordings.flatMap((recording) => {
      const begin = toSeconds(recording.begin);

      return begin < at ? [begin] : [];
    }),
  );

  return starts.length === 0 ? undefined : Math.max(...starts);
};
