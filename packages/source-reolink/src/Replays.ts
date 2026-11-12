/**
 * A hub or recorder's files, handed over by replaying each over Reolink's
 * own protocol on port 9000, as its HTTP API won't prepare a download.
 * Replays come as H.265 or H.264 with no timing of their own, so each is
 * put in an MP4 with ffmpeg, `KESTREL_FFMPEG` or the one on the path, and
 * H.265 is converted to H.264 on the way. One file at a time.
 *
 * @module
 */
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Codec, Media, Session } from "@timmo001/kestrel-protocol-baichuan";
import { SourceUnavailable, type LocalTime } from "@timmo001/kestrel-core";
import * as Mp4 from "@timmo001/kestrel-format-mp4";
import {
  Config,
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

/** Frames a second, from how far the device's wrapping microsecond counter moved. */
const fpsOf = (frames: ReadonlyArray<Media.MediaFrame>) => {
  const first = frames.at(0)?.microseconds ?? 0;
  const last = frames.at(-1)?.microseconds ?? 0;
  const span = (last - first + 2 ** 32) % 2 ** 32;

  return frames.length > 1 && span > 0
    ? ((frames.length - 1) * 1e6) / span
    : fallbackFps;
};

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
        const bytes = yield* Effect.scoped(
          Session.connect({
            host: options.host,
            username: options.username,
            password: options.password,
          }).pipe(
            Effect.flatMap((session) =>
              session.replay({ channel, file: file.name }),
            ),
          ),
        );

        const media = Media.decode(bytes);

        if (media.frames.length === 0) {
          return yield* unavailable("replayed a file with no video");
        }

        yield* fs.writeFile(
          raw,
          Codec.concat(...media.frames.map((frame) => frame.data)),
        );

        const hevc = media.codec === "H265";

        // Frames in the order they show, with a key frame every few seconds to seek to
        const encode = hevc
          ? [
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "26",
              "-pix_fmt",
              "yuv420p",
              "-bf",
              "0",
              "-g",
              "50",
            ]
          : ["-c:v", "copy"];

        const args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          hevc ? "hevc" : "h264",
          "-r",
          fpsOf(media.frames).toFixed(3),
          "-i",
          raw,
          "-map",
          "0:v:0",
          ...encode,
          "-movflags",
          "+faststart",
          mp4,
        ];

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
    }) => {
      const from = toSeconds(request.begin);
      const to = toSeconds(request.end);

      return Stream.fromIterable(request.files).pipe(
        Stream.flatMap((file) =>
          Stream.unwrap(
            replayed(file, request.channel, from, to, request.every),
          ).pipe(Stream.mapError(handOver)),
        ),
      );
    },
  };
});
