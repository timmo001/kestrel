/**
 * What plays at a moment when several channels play together: each
 * channel's recording at that recorder time, if it has one, which channel's
 * video keeps the time, and the next moment any of them recorded. Plain
 * functions with no page in them, so they can be tested.
 */
import type { Recording } from "@timmo001/kestrel-core/domain";
import { toSeconds } from "./player.ts";

/** A channel and its day's recordings, earliest first. */
export interface Track {
  readonly channel: number;
  readonly recordings: ReadonlyArray<Recording>;
}

/** What one channel shows at a moment: its recording then, or nothing. */
export interface Shown {
  readonly channel: number;
  readonly recording: Recording | undefined;
}

export interface Moment {
  readonly shown: ReadonlyArray<Shown>;
  /** The channel whose video keeps the time, when any recorded then. */
  readonly driver: number | undefined;
}

/**
 * A channel's recording at `at`, in recorder seconds. Where one file runs
 * straight into the next, the join belongs to the later one.
 */
export const recordingAt = (recordings: ReadonlyArray<Recording>, at: number) =>
  recordings.findLast(
    (recording) =>
      toSeconds(recording.begin) <= at && at < toSeconds(recording.end),
  );

/**
 * What each channel shows at `at`, and which keeps the time: the picked
 * channel when it recorded then, or else the first that did, in order.
 */
export const momentAt = (
  tracks: ReadonlyArray<Track>,
  picked: number,
  at: number,
): Moment => {
  const shown = tracks.map((track) => ({
    channel: track.channel,
    recording: recordingAt(track.recordings, at),
  }));

  const driver =
    shown.find(
      (one) => one.channel === picked && one.recording !== undefined,
    ) ?? shown.find((one) => one.recording !== undefined);

  return { shown, driver: driver?.channel };
};

/** The first moment after `at` that any channel starts a recording, if there's one. */
export const nextMoment = (tracks: ReadonlyArray<Track>, at: number) => {
  const starts = tracks.flatMap((track) =>
    track.recordings.flatMap((recording) => {
      const begin = toSeconds(recording.begin);

      return begin > at ? [begin] : [];
    }),
  );

  return starts.length === 0 ? undefined : Math.min(...starts);
};

/** The last moment before `at` that any channel started a recording, if there's one. */
export const previousMoment = (tracks: ReadonlyArray<Track>, at: number) => {
  const starts = tracks.flatMap((track) =>
    track.recordings.flatMap((recording) => {
      const begin = toSeconds(recording.begin);

      return begin < at ? [begin] : [];
    }),
  );

  return starts.length === 0 ? undefined : Math.max(...starts);
};
