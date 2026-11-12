/**
 * Recorded video as MP4: which stretches of which files to ask the recorder
 * for, and the frames it sends written as fragmented MP4, which a browser
 * plays as it arrives and any player opens as a file.
 *
 * @module
 */
import type { LocalTime, Recorded, Recording } from "@timmo001/kestrel-rsnet";
import { Effect, Schema, Stream } from "effect";
import {
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";

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
  recordings: ReadonlyArray<Recording>,
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

/** The frames couldn't be written as MP4. */
export class Mp4Error extends Schema.TaggedError<Mp4Error>()("Mp4Error", {
  message: Schema.String,
}) {}

const hex = (value: number) => value.toString(16).padStart(2, "0");

/**
 * The codec string for a key frame's SPS, such as `avc1.64002a`: its
 * profile, constraint flags and level, the three bytes after its NAL header.
 */
export const avcCodec = (data: Uint8Array) => {
  for (let index = 0; index + 4 < data.length; index++) {
    const isStart =
      data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1;

    if (isStart && ((data[index + 3] ?? 0) & 0x1f) === 7) {
      return `avc1.${hex(data[index + 4] ?? 0)}${hex(data[index + 5] ?? 0)}${hex(data[index + 6] ?? 0)}`;
    }
  }

  return "avc1.640028";
};

type RecordedFrame = Recorded.RecordedFrame;

/** Gaps longer than this, such as between motion clips, play as one frame. */
const longestGap = 2;

/**
 * Writes frames as fragmented MP4, a fragment per key frame group, and
 * passes the bytes on as they're written. Frames before the first key frame,
 * and any that don't move time forward, are left out. Time runs from 0 at the
 * first frame, with gaps between files closed up, `speedUp` times faster
 * than it was recorded.
 */
export const toMp4 = <E>(
  frames: Stream.Stream<RecordedFrame, E>,
  speedUp = 1,
): Stream.Stream<Uint8Array, E | Mp4Error> =>
  Stream.unwrap(
    Effect.sync(() => {
      const written: Array<Uint8Array> = [];
      let position = 0;
      let problem: string | undefined;

      const write = (chunk: StreamTargetChunk) => {
        // Fragmented MP4 is written straight through; anything else can't
        // go out over HTTP as it comes
        if (chunk.position !== position) {
          problem = `MP4 writer went back to byte ${chunk.position}`;
        }

        written.push(chunk.data);
        position += chunk.data.length;
      };

      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "fragmented" }),
        target: new StreamTarget(new WritableStream({ write })),
      });

      const source = new EncodedVideoPacketSource("avc");

      output.addVideoTrack(source);

      let previous: RecordedFrame | undefined;
      let timestamp = 0;

      /** Adds the frame before this one, now that its duration is known. */
      const add = async (frame: RecordedFrame | undefined) => {
        if (previous === undefined) {
          if (frame === undefined || !frame.key) return;

          await output.start();
          previous = frame;

          return;
        }

        const frameLength = 1 / Math.max(previous.fps, 1);

        const gap =
          frame === undefined
            ? frameLength
            : (frame.time - previous.time) / 1e6;

        // Out of order or repeated, such as where two files overlap
        if (frame !== undefined && gap <= 0) return;

        const duration = (gap > longestGap ? frameLength : gap) / speedUp;

        await source.add(
          new EncodedPacket(
            previous.data,
            previous.key ? "key" : "delta",
            timestamp,
            duration,
          ),
          timestamp === 0
            ? {
                decoderConfig: {
                  codec: avcCodec(previous.data),
                  codedWidth: previous.width,
                  codedHeight: previous.height,
                },
              }
            : undefined,
        );

        timestamp += duration;
        previous = frame;
      };

      const take = Effect.suspend(() =>
        problem === undefined
          ? Effect.succeed(written.splice(0))
          : Effect.fail(new Mp4Error({ message: problem })),
      );

      const step = (run: () => Promise<void>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) =>
            new Mp4Error({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(Effect.andThen(take));

      const finish = step(async () => {
        await add(undefined);

        if (output.state === "started") await output.finalize();
      });

      return frames.pipe(
        Stream.mapEffect((frame) => step(() => add(frame))),
        Stream.concat(Stream.fromEffect(finish)),
        Stream.flattenIterable,
        Stream.ensuring(
          Effect.promise(async () => {
            if (output.state === "started") await output.cancel();
          }),
        ),
      );
    }),
  );
