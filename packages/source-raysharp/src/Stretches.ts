/**
 * Which stretches of which recorded files to ask a Raysharp recorder for,
 * to cover a range across its files, and the recorder times they're
 * worked out in.
 *
 * @module
 */
import type { ChannelRecording, LocalTime } from "@timmo001/kestrel-core";

/** A recorder time as seconds since 1970, read as UTC: the recorder keeps no zone. */
export const toSeconds = (time: LocalTime) => Date.parse(`${time}Z`) / 1000;

/** Seconds since 1970 as a recorder time. */
export const fromSeconds = (seconds: number): LocalTime =>
  new Date(seconds * 1000).toISOString().slice(0, 19);

/** One stretch to download, inside one recorded file. */
export interface Stretch {
  readonly begin: LocalTime;
  readonly end: LocalTime;
}

/**
 * The stretches of the files a search found between `begin` and `end`, one
 * per file, in order. The recorder picks a download's file by its end, and
 * where the next file starts as one ends, a range ending there gets the next
 * file. So a file followed straight on stops a second short; its last key
 * frame group runs to its end anyway.
 */
export const stretches = (
  recordings: ReadonlyArray<ChannelRecording>,
  begin: LocalTime,
  end: LocalTime,
): Array<Stretch> => {
  const from = toSeconds(begin);
  const to = toSeconds(end);

  const sorted = recordings.toSorted((a, b) => a.begin.localeCompare(b.begin));

  return sorted.flatMap((recording, index) => {
    const next = sorted[index + 1];
    const fileEnd = toSeconds(recording.end);

    const last =
      next !== undefined && toSeconds(next.begin) <= fileEnd
        ? fileEnd - 1
        : fileEnd;

    const start = Math.max(from, toSeconds(recording.begin));
    const stop = Math.min(to, last);

    return stop > start
      ? [{ begin: fromSeconds(start), end: fromSeconds(stop) }]
      : [];
  });
};
