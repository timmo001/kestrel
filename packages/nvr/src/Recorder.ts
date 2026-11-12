/**
 * Records a camera to disk and clears out old days. ffmpeg reads the
 * camera's stream as it arrives and writes it unchanged, video only, as
 * fragmented MP4 files cut every few minutes on the clock, so a crash loses
 * seconds rather than a file. Each camera gets a folder of days, each day a
 * file per stretch: `<key>/<day>/<time>.mp4`, by this machine's local time.
 * It knows nothing of where a stream comes from; the caller hands it an
 * address and a key, such as a camera's id.
 *
 * @module
 */
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Path,
  Schedule,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { InvalidKey, dayPattern, isKey, localDate, marker } from "./Layout.ts";

const day = Duration.toMillis(Duration.days(1));

const restart = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

export interface RecordOptions {
  /** The ffmpeg binary. */
  readonly ffmpeg: string;
  /** The folder every camera's recordings go in. */
  readonly folder: string;
  /** The camera's own folder within it, such as `front-door/1`. */
  readonly key: string;
  /** The stream to record, any address ffmpeg reads, such as an MP4 stream over HTTP. */
  readonly input: string;
  /** How long each file runs. */
  readonly segment: Duration.Duration;
}

/**
 * Records a camera until interrupted. When ffmpeg stops, such as when the
 * stream drops, it starts again, waiting longer each time up to 30 seconds.
 */
export const record = Effect.fnUntraced(function* (options: RecordOptions) {
  if (!isKey(options.key)) {
    return yield* new InvalidKey({ key: options.key });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const folder = path.join(options.folder, ...options.key.split("/"));

  // ffmpeg doesn't make folders, so today's and tomorrow's are made ahead
  const days = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(path.join(folder, marker), "");

    yield* Effect.forEach([now, now + day], (time) =>
      fs.makeDirectory(path.join(folder, localDate(time)), {
        recursive: true,
        mode: 0o700,
      }),
    );
  });

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    // Gives up on a stream that stops sending, after 10 seconds
    "-rw_timeout",
    "10000000",
    "-i",
    options.input,
    "-map",
    "0:v:0",
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_time",
    String(Duration.toSeconds(options.segment)),
    "-segment_atclocktime",
    "1",
    "-reset_timestamps",
    "1",
    "-strftime",
    "1",
    "-segment_format",
    "mp4",
    "-segment_format_options",
    "movflags=+frag_keyframe+empty_moov+default_base_moof",
    path.join(folder, "%Y-%m-%d", "%H-%M-%S.mp4"),
  ];

  const run = Effect.scoped(
    Effect.gen(function* () {
      yield* days;

      const handle = yield* spawner.spawn(
        ChildProcess.make(options.ffmpeg, args, {
          // In the caller's process group, so stopping it stops ffmpeg too
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        }),
      );

      yield* handle.stderr.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.logWarning(`Recording ${options.key}: ${line}`),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );

      const code = yield* handle.exitCode;

      return yield* Effect.fail(
        `Recording ${options.key} stopped: ffmpeg exited with code ${code}`,
      );
    }),
  );

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* days.pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.forkScoped,
      );

      return yield* run.pipe(
        Effect.tapError((error) => Effect.logWarning(String(error))),
        Effect.retry(restart),
      );
    }),
  );
});

export interface PruneOptions {
  /** The folder every camera's recordings go in. */
  readonly folder: string;
  /** How many days back to keep, besides today. */
  readonly days: number;
}

/**
 * Deletes the days older than `days` from every camera recorded in a
 * folder, including ones no longer recorded, and returns how many went. Only
 * folders this records into are touched, so a shared folder is safe.
 */
export const prune = Effect.fnUntraced(function* (options: PruneOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const cutoff = localDate(now - options.days * day);

  if (!(yield* fs.exists(options.folder))) return 0;

  const entries = yield* fs.readDirectory(options.folder, { recursive: true });

  const cameras = entries.flatMap((entry) =>
    path.basename(entry) === marker
      ? [path.join(options.folder, path.dirname(entry))]
      : [],
  );

  const old = yield* Effect.forEach(cameras, (camera) =>
    fs
      .readDirectory(camera)
      .pipe(
        Effect.map((names) =>
          names.flatMap((name) =>
            dayPattern.test(name) && name < cutoff
              ? [path.join(camera, name)]
              : [],
          ),
        ),
      ),
  );

  yield* Effect.forEach(old.flat(), (folder) =>
    fs.remove(folder, { recursive: true }),
  );

  return old.flat().length;
});
