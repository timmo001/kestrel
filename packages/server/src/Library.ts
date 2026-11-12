/**
 * The recordings library: every recording the server has, read only from
 * the recordings folder, so playback never reaches a recorder or camera.
 * Kestrel's own recordings are written there, and each source's are copied
 * in, with why each was made kept as tags in its file name.
 *
 * @module
 */
import {
  NoRecordings,
  RecordingReason,
  UnknownCamera,
  type CameraId,
  type LocalTime,
  type RecordedDay,
  type RecordedFrame,
  type Recording,
} from "@timmo001/kestrel-core";
import * as Mp4 from "@timmo001/kestrel-format-mp4";
import * as Nvr from "@timmo001/kestrel-nvr";
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ownRecordingsFolder } from "./Folders.ts";
import { Sources } from "./Sources.ts";

/** A local time as seconds since 1970, read as UTC, as sources keep their clocks. */
const toSeconds = (time: string) => Date.parse(`${time}Z`) / 1000;

const fromSeconds = (seconds: number): LocalTime =>
  new Date(Math.round(seconds) * 1000).toISOString().slice(0, 19);

const daySeconds = 86_400;

/** The tag a reason is kept as in a file's name, such as `alarm-input`. */
export const reasonTag = (reason: RecordingReason) =>
  reason.toLowerCase().replaceAll(" ", "-");

/** The reasons in a file's tags; a file with none was recorded all the time. */
const reasonsOf = (tags: ReadonlyArray<string>) => {
  const found = tags.flatMap((tag) =>
    RecordingReason.literals.filter((reason) => reasonTag(reason) === tag),
  );

  const normal: Array<RecordingReason> = ["normal"];

  return found.length === 0 ? normal : found;
};

/** Days from several cameras as one list, by date, each with every reason. */
export const mergeDays = (
  days: ReadonlyArray<RecordedDay>,
): Array<RecordedDay> => {
  const byDate = new Map<string, Set<RecordingReason>>();

  for (const day of days) {
    const reasons = byDate.get(day.date) ?? new Set();

    for (const reason of day.reasons) reasons.add(reason);
    byDate.set(day.date, reasons);
  }

  return [...byDate]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([date, reasons]) => ({ date, reasons: [...reasons] }));
};

export interface VideoOptions {
  readonly camera: CameraId;
  readonly begin: LocalTime;
  readonly end: LocalTime;
  /** Key frames only, one per this many seconds. */
  readonly every?: number | undefined;
}

export class Library extends Context.Service<
  Library,
  {
    /** The cameras with recordings, by id. */
    readonly cameras: Effect.Effect<ReadonlyArray<string>>;
    /** Days with recordings on any camera in a month, such as `2026-11`. */
    readonly days: (month: string) => Effect.Effect<Array<RecordedDay>>;
    /** A camera's recordings on one day, such as `2026-11-12`. */
    readonly list: (
      camera: CameraId,
      date: string,
    ) => Effect.Effect<Array<Recording>, UnknownCamera>;
    /**
     * What a camera recorded between two times, as its frames, across files
     * in order. Where files overlap, such as a camera's own clips beside
     * Kestrel's recording, the one already playing carries on.
     */
    readonly video: (
      options: VideoOptions,
    ) => Effect.Effect<
      Stream.Stream<RecordedFrame, Mp4.Mp4Error>,
      NoRecordings | UnknownCamera
    >;
  }
>()("@timmo001/kestrel-server/Library") {
  static readonly layer = Layer.effect(
    Library,
    Effect.gen(function* () {
      const sources = yield* Sources;
      const own = yield* ownRecordingsFolder;
      const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

      const folder = sources.settings.pipe(
        Effect.map((settings) => settings.recording.folder ?? own),
      );

      const unknown = (camera: string) => () =>
        Effect.fail(
          new UnknownCamera({
            message: `There are no recordings of ${camera}`,
          }),
        );

      const cameras = folder.pipe(
        Effect.flatMap(Nvr.Library.cameras),
        Effect.provideContext(files),
      );

      const days = (month: string) =>
        Effect.gen(function* () {
          const root = yield* folder;

          const lists = yield* Effect.forEach(yield* cameras, (key) =>
            Nvr.Library.days(root, key, month).pipe(
              Effect.orElseSucceed(() => []),
            ),
          );

          return mergeDays(
            lists.flat().flatMap((day): Array<RecordedDay> => {
              const tagged = day.tags.length === 0 ? [] : [reasonsOf(day.tags)];

              const untagged = day.untagged ? [reasonsOf([])] : [];

              return [
                { date: day.date, reasons: [...tagged, ...untagged].flat() },
              ];
            }),
          );
        }).pipe(Effect.provideContext(files));

      const list = (camera: CameraId, date: string) =>
        folder.pipe(
          Effect.flatMap((root) => Nvr.Library.files(root, camera, date)),
          Effect.map((found) =>
            found.map((file): Recording => ({
              camera,
              begin: file.begin,
              end: fromSeconds(toSeconds(file.begin) + file.duration),
              reasons: reasonsOf(file.tags),
              bytes: file.bytes,
            })),
          ),
          Effect.catchTag("InvalidKey", unknown(camera)),
          Effect.provideContext(files),
        );

      const video = (options: VideoOptions) =>
        Effect.gen(function* () {
          const root = yield* folder;
          const from = toSeconds(options.begin);
          const to = toSeconds(options.end);

          // From the day before, for a file that runs past midnight
          const dates = Array.from(
            { length: Math.floor((to - from) / daySeconds) + 2 },
            (_, index) =>
              fromSeconds(from + (index - 1) * daySeconds).slice(0, 10),
          );

          const found = yield* Effect.forEach(dates, (date) =>
            Nvr.Library.files(root, options.camera, date),
          );

          let reached = from;

          const parts = found.flat().flatMap((file) => {
            const start = toSeconds(file.begin);
            const stop = Math.min(start + file.duration, to);
            const begin = Math.max(start, reached);

            if (stop <= begin) return [];

            reached = stop;

            return [{ file, start, begin, stop }];
          });

          if (parts.length === 0) {
            return yield* new NoRecordings({
              message: `Nothing was recorded on ${options.camera} from ${options.begin} to ${options.end}`,
            });
          }

          return Stream.fromIterable(parts).pipe(
            Stream.flatMap((part) =>
              Mp4.frames({
                path: part.file.path,
                start: part.start * 1e6,
                from: part.begin - part.start,
                to: part.stop - part.start,
                every: options.every,
              }),
            ),
          );
        }).pipe(
          Effect.catchTag("InvalidKey", unknown(options.camera)),
          Effect.provideContext(files),
        );

      return Library.of({ cameras, days, list, video });
    }),
  );
}
