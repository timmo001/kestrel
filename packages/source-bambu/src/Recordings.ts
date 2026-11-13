/**
 * The printer's recordings, from its storage: what its camera records
 * during prints, as the camera's continuous footage, and the timelapse it
 * makes of each print, as a camera of its own so the two don't play over
 * each other. Each file ends when it was last written. They're MJPEG, so
 * each is handed over by downloading it and converting it to H.264 with
 * ffmpeg, `KESTREL_FFMPEG` or the one on the path, one file at a time.
 *
 * @module
 */
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import {
  NoRecordings,
  SourceUnavailable,
  UnknownCamera,
  type CameraId,
  type LocalTime,
  type Pace,
  type RecordedDay,
  type RecordedFrame,
  type Recording,
  type RecordingReason,
  type SourceRecordings,
} from "@timmo001/kestrel-core";
import * as Mp4 from "@timmo001/kestrel-format-mp4";
import {
  Config,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Ref,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  download,
  lastWritten,
  listFiles,
  type FileKind,
  type Login,
  type PrinterFile,
} from "./Storage.ts";

/** How long a listing of the printer's files is reused. */
const listedFor = Duration.minutes(1);

const kinds: ReadonlyArray<FileKind> = ["timelapse", "recording"];

const reasonsOf: Record<FileKind, Array<RecordingReason>> = {
  timelapse: ["timelapse"],
  recording: ["normal"],
};

interface Listed extends PrinterFile {
  readonly end: LocalTime;
}

/** A local time as seconds since 1970, read as UTC, as the printer keeps its clock. */
const toSeconds = (time: string) => Date.parse(`${time}Z`) / 1000;

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

export interface RecordingsOptions {
  readonly name: string;
  readonly login: Login;
  /** The camera each kind of file belongs to. */
  readonly cameras: Record<FileKind, CameraId>;
}

/** The printer's recordings, listed and handed over from its storage. */
export const printerRecordings = Effect.fnUntraced(function* (
  options: RecordingsOptions,
) {
  const { name, login, cameras } = options;
  const context = yield* Layer.build(services);

  const ffmpeg = yield* Config.String("KESTREL_FFMPEG").pipe(
    Effect.orElseSucceed(() => "ffmpeg"),
  );

  // Downloads and conversions are heavy, so they take turns
  const converting = yield* Semaphore.make(1);

  /** When each file ends, by its path, kept as finished files don't change. */
  const ends = yield* Ref.make(new Map<string, LocalTime>());

  const unavailable = (error: { readonly message: string }) =>
    new SourceUnavailable({ message: `${name} ${error.message}` });

  const files = yield* Effect.gen(function* () {
    const listed = yield* listFiles(login);
    const known = yield* Ref.get(ends);

    // The newest in each folder may still be being written
    const newest = new Set(
      kinds.map((kind) => listed.findLast((file) => file.kind === kind)?.path),
    );

    const unread = listed.flatMap((file) =>
      known.has(file.path) && !newest.has(file.path) ? [] : [file.path],
    );

    const read =
      unread.length === 0
        ? new Map<string, LocalTime>()
        : yield* lastWritten(login, unread);

    const all = new Map([...known, ...read]);

    yield* Ref.set(ends, all);

    return listed.map((file): Listed => ({
      path: file.path,
      kind: file.kind,
      begin: file.begin,
      bytes: file.bytes,
      end: all.get(file.path) ?? file.begin,
    }));
  }).pipe(Effect.mapError(unavailable), Effect.cachedWithTTL(listedFor));

  /** A failure handing a video over, keeping its own message where it's already the source's. */
  const handOver = (error: {
    readonly _tag: string;
    readonly message: string;
  }) =>
    Predicate.isTagged(error, "SourceUnavailable")
      ? new SourceUnavailable({ message: error.message })
      : unavailable({ message: "couldn't hand over a video" });

  const kindOf = (camera: CameraId) =>
    kinds.find((kind) => cameras[kind] === camera);

  const unknown = (camera: CameraId) =>
    new UnknownCamera({ message: `${name} has no camera ${camera}` });

  /** A file downloaded and converted, as its frames between two times, its folder cleared once read. */
  const converted = (
    file: Listed,
    from: number,
    to: number,
    every: number | undefined,
    pace: Pace | undefined,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const folder = yield* fs.makeTempDirectory({ prefix: "kestrel-bambu-" });

      const clear = fs
        .remove(folder, { recursive: true, force: true })
        .pipe(Effect.ignore);

      const avi = path.join(folder, "video.avi");
      const mp4 = path.join(folder, "video.mp4");

      // Background work converts on one thread, so the machine keeps the rest;
      // a short lookahead holds a few frames rather than many
      const threads = ["-threads", pace === undefined ? "4" : "1"];

      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        ...threads,
        "-i",
        avi,
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-x264-params",
        "rc-lookahead=4:sync-lookahead=0",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        // Frames in the order they show, with a key frame every few seconds to seek to
        "-bf",
        "0",
        "-g",
        "50",
        ...threads,
        "-movflags",
        "+faststart",
        mp4,
      ];

      yield* Effect.gen(function* () {
        if (pace !== undefined) yield* pace.room;

        yield* download(login, file.path, avi);

        if (pace !== undefined) yield* pace.room;

        const code = yield* Effect.scoped(
          spawner
            .spawn(
              ChildProcess.make(ffmpeg, args, {
                detached: false,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            )
            .pipe(Effect.flatMap((handle) => handle.exitCode)),
        );

        if (code !== 0) {
          return yield* new SourceUnavailable({
            message: `${name}'s video couldn't be converted: ffmpeg exited with code ${code}`,
          });
        }

        yield* fs.remove(avi);
      }).pipe(
        (effect) => converting.withPermit(effect),
        Effect.onError(() => clear),
      );

      const start = toSeconds(file.begin);

      const { duration } = yield* Mp4.info(mp4).pipe(
        Effect.onError(() => clear),
      );

      // Its camera's recordings hold a frame every second or two, stamped as
      // if far faster, so they're stretched over the time they cover; a
      // timelapse plays at its own speed from when the print started
      const scale =
        file.kind === "recording" && duration > 0
          ? Math.max(toSeconds(file.end) - start, duration) / duration
          : 1;

      return Mp4.frames({
        path: mp4,
        start: start * 1e6,
        from: (from - start) / scale,
        to: (to - start) / scale,
        every: every === undefined ? undefined : every / scale,
      }).pipe(
        Stream.map((frame): RecordedFrame => ({
          key: frame.key,
          time: start * 1e6 + Math.round((frame.time - start * 1e6) * scale),
          width: frame.width,
          height: frame.height,
          fps: frame.fps / scale,
          data: frame.data,
        })),
        Stream.ensuring(clear),
      );
    }).pipe(Effect.mapError(handOver), Effect.provideContext(context));

  const recordings: SourceRecordings = {
    days: (month) =>
      files.pipe(
        Effect.map((all) => {
          const byDate = new Map<string, Set<RecordingReason>>();

          for (const file of all) {
            if (!file.begin.startsWith(`${month}-`)) continue;

            const date = file.begin.slice(0, 10);
            const reasons = byDate.get(date) ?? new Set();

            for (const reason of reasonsOf[file.kind]) reasons.add(reason);
            byDate.set(date, reasons);
          }

          return [...byDate]
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([date, reasons]): RecordedDay => ({
              date,
              reasons: [...reasons],
            }));
        }),
      ),
    list: Effect.fnUntraced(function* (camera, date) {
      const kind = kindOf(camera);

      if (kind === undefined) return yield* unknown(camera);

      return (yield* files).flatMap((file): Array<Recording> =>
        file.kind === kind && file.begin.startsWith(date)
          ? [
              {
                camera,
                begin: file.begin,
                end: file.end,
                reasons: reasonsOf[file.kind],
                bytes: file.bytes,
              },
            ]
          : [],
      );
    }),
    video: Effect.fnUntraced(function* (options) {
      const kind = kindOf(options.camera);

      if (kind === undefined) return yield* unknown(options.camera);

      const from = toSeconds(options.begin);
      const to = toSeconds(options.end);

      const parts = (yield* files).filter(
        (file) =>
          file.kind === kind &&
          toSeconds(file.begin) < to &&
          toSeconds(file.end) > from,
      );

      if (parts.length === 0) {
        return yield* new NoRecordings({
          message: `Nothing was recorded on ${options.camera} from ${options.begin} to ${options.end}`,
        });
      }

      return Stream.fromIterable(parts).pipe(
        Stream.flatMap((file) =>
          Stream.unwrap(
            converted(file, from, to, options.every, options.pace),
          ).pipe(Stream.mapError(handOver)),
        ),
      );
    }),
  };

  return recordings;
});
