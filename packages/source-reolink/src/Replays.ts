/**
 * A hub or recorder's files, handed over by replaying each over Reolink's
 * own protocol on port 9000, as its HTTP API won't prepare a download.
 * Replays come as H.265 or H.264 with no timing of their own, so each is
 * put in an MP4 with ffmpeg, `KESTREL_FFMPEG` or the one on the path, and
 * H.265 is converted to H.264 on the way. One file at a time, written to
 * disk as it comes; background work reads it at the copy rate and converts
 * on one thread, at the lowest priority.
 *
 * @module
 */
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Media, Session } from "@timmo001/kestrel-protocol-baichuan";
import {
  SourceUnavailable,
  type LocalTime,
  type Pace,
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
  Redacted,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { constants, setPriority } from "node:os";

/** One file on the device, as its search lists it. */
export interface DeviceFile {
  /** Its path on the device. */
  readonly name: string;
  readonly begin: LocalTime;
  readonly end: LocalTime;
}

export interface ReplaysOptions {
  readonly name: string;
  readonly host: string;
  readonly username: Redacted.Redacted;
  readonly password: Redacted.Redacted;
}

/** What a replay's frame rate is taken as when it can't tell. */
const fallbackFps = 15;

/** A local time as seconds since 1970, read as UTC, as the device keeps its clock. */
const toSeconds = (time: string) => Date.parse(`${time}Z`) / 1000;

/** What a replay held, counted as it's written out. */
interface Counted {
  count: number;
  first: number;
  last: number;
}

/** Frames a second, from how far the device's wrapping microsecond counter moved. */
const fpsOf = ({ count, first, last }: Counted) => {
  const span = (last - first + 2 ** 32) % 2 ** 32;

  return count > 1 && span > 0 ? ((count - 1) * 1e6) / span : fallbackFps;
};

/**
 * ffmpeg, at the lowest priority for background work, so anything else on
 * the machine comes first. `nice` sets it before ffmpeg starts its threads,
 * which each keep their own; Windows has no `nice`, so `lower` sets it there.
 */
const lowest = (
  background: boolean,
  ffmpeg: string,
  args: ReadonlyArray<string>,
) => {
  const options = {
    detached: false,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  } as const;

  return background && process.platform !== "win32"
    ? ChildProcess.make("nice", ["-n", "19", ffmpeg, ...args], options)
    : ChildProcess.make(ffmpeg, args, options);
};

/** Drops a background process to the lowest priority on Windows, where priority covers the whole process. */
const lower = (background: boolean, pid: number) =>
  background && process.platform === "win32"
    ? Effect.try({
        try: () => setPriority(pid, constants.priority.PRIORITY_LOW),
        catch: (error) => error,
      }).pipe(Effect.ignore)
    : Effect.void;

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

/** Replays a device's files as recorded frames. */
export const deviceReplays = Effect.fnUntraced(function* (
  options: ReplaysOptions,
) {
  const { name } = options;
  const context = yield* Layer.build(services);

  const ffmpeg = yield* Config.String("KESTREL_FFMPEG").pipe(
    Effect.orElseSucceed(() => "ffmpeg"),
  );

  // Replays and conversions are heavy, so they take turns
  const converting = yield* Semaphore.make(1);

  const unavailable = (message: string) =>
    new SourceUnavailable({ message: `${name} ${message}` });

  /** A failure handing a video over, keeping its own message where it's already the source's. */
  const handOver = (error: {
    readonly _tag: string;
    readonly message: string;
  }) =>
    Predicate.isTagged(error, "SourceUnavailable")
      ? new SourceUnavailable({ message: error.message })
      : unavailable(`couldn't hand over a video: ${error.message}`);

  /** A main-stream file's frames between two times, in seconds since 1970; with `every`, key frames that far apart. */
  const replayed = (
    file: DeviceFile,
    channel: number,
    from: number,
    to: number,
    every: number | undefined,
    pace: Pace | undefined,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const folder = yield* fs.makeTempDirectory({
        prefix: "kestrel-reolink-",
      });

      const clear = fs
        .remove(folder, { recursive: true, force: true })
        .pipe(Effect.ignore);

      const raw = path.join(folder, "video.raw");
      const mp4 = path.join(folder, "video.mp4");

      yield* Effect.gen(function* () {
        const reading = Media.decoder();
        const counted: Counted = { count: 0, first: 0, last: 0 };

        const pieces = Session.connect({
          host: options.host,
          username: options.username,
          password: options.password,
        }).pipe(
          Effect.map((session) => session.replay({ channel, file: file.name })),
          Stream.unwrap,
        );

        const paced =
          pace === undefined
            ? pieces
            : pieces.pipe(
                Stream.tap(() => pace.room),
                Stream.throttle({
                  cost: (chunks) =>
                    chunks.reduce((total, chunk) => total + chunk.length, 0),
                  units: pace.bytesPerSecond,
                  duration: Duration.seconds(1),
                  burst: pace.bytesPerSecond,
                  strategy: "shape",
                }),
              );

        // Written as it comes, so a whole file is never held at once
        yield* paced.pipe(
          Stream.flatMap((piece) => Stream.fromIterable(reading.push(piece))),
          Stream.concat(
            Stream.suspend(() => Stream.fromIterable(reading.end())),
          ),
          Stream.map((frame) => {
            if (counted.count === 0) counted.first = frame.microseconds;
            counted.count += 1;
            counted.last = frame.microseconds;

            return frame.data;
          }),
          Stream.run(fs.sink(raw)),
        );

        if (counted.count === 0) {
          return yield* unavailable("replayed a file with no video");
        }

        const hevc = reading.codec() === "H265";

        // Background work converts on one thread, so the machine keeps the rest;
        // a short lookahead holds a few 4K frames rather than gigabytes
        const threads = ["-threads", pace === undefined ? "4" : "1"];

        // Frames in the order they show, with a key frame every few seconds to seek to
        const encode = hevc
          ? [
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-x264-params",
              "rc-lookahead=4:sync-lookahead=0",
              "-crf",
              "26",
              "-pix_fmt",
              "yuv420p",
              "-bf",
              "0",
              "-g",
              "50",
              ...threads,
            ]
          : ["-c:v", "copy"];

        const args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          ...threads,
          "-f",
          hevc ? "hevc" : "h264",
          "-r",
          fpsOf(counted).toFixed(3),
          "-i",
          raw,
          "-map",
          "0:v:0",
          ...encode,
          "-movflags",
          "+faststart",
          mp4,
        ];

        if (pace !== undefined) yield* pace.room;

        const code = yield* Effect.scoped(
          spawner.spawn(lowest(pace !== undefined, ffmpeg, args)).pipe(
            Effect.tap((handle) => lower(pace !== undefined, handle.pid)),
            Effect.flatMap((handle) => handle.exitCode),
          ),
        );

        if (code !== 0) {
          return yield* unavailable(
            `couldn't convert a video: ffmpeg exited with code ${code}`,
          );
        }

        yield* fs.remove(raw);
      }).pipe(
        (effect) => converting.withPermit(effect),
        Effect.onError(() => clear),
      );

      const start = toSeconds(file.begin);

      return Mp4.frames({
        path: mp4,
        start: start * 1e6,
        from: from - start,
        to: to - start,
        every,
      }).pipe(Stream.ensuring(clear));
    }).pipe(Effect.mapError(handOver), Effect.provideContext(context));

  return {
    /** What a channel's files hold between two local times, one file after another. */
    video: (request: {
      readonly channel: number;
      readonly files: ReadonlyArray<DeviceFile>;
      readonly begin: LocalTime;
      readonly end: LocalTime;
      readonly every?: number | undefined;
      readonly pace?: Pace | undefined;
    }) => {
      const from = toSeconds(request.begin);
      const to = toSeconds(request.end);

      return Stream.fromIterable(request.files).pipe(
        Stream.flatMap((file) =>
          Stream.unwrap(
            replayed(
              file,
              request.channel,
              from,
              to,
              request.every,
              request.pace,
            ),
          ).pipe(Stream.mapError(handOver)),
        ),
      );
    },
  };
});
