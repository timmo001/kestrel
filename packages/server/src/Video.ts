/**
 * Live video through go2rtc. Browsers can't play RTSP, so the server runs
 * go2rtc beside it with a stream for each channel's main and sub stream, and
 * the web client plays them through the server, under `/go2rtc/`. The config holds the recorder's
 * login, so it's written to a private temporary file rather than passed on
 * the command line, and go2rtc's own logging is kept off.
 *
 * @module
 */
import {
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schedule,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { LiveStream, RecorderUnavailable, VideoSources } from "./Api.ts";
import { basePath } from "./Go2rtc.ts";
import { Recorder } from "./Recorder.ts";

const restart = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

const twoDigits = (channel: number) => String(channel).padStart(2, "0");

/** A channel's go2rtc stream names. */
export const streamsFor = (channels: number): Array<LiveStream> =>
  Array.from({ length: channels }, (_, index) => {
    const channel = index + 1;

    return {
      channel,
      name: `Channel ${channel}`,
      main: `ch${twoDigits(channel)}`,
      sub: `ch${twoDigits(channel)}_sub`,
    };
  });

export class Video extends Context.Service<
  Video,
  {
    /** The port go2rtc listens on, on 127.0.0.1. */
    readonly port: number;
    readonly sources: Effect.Effect<VideoSources, RecorderUnavailable>;
  }
>()("@timmo001/dvr-revival-server/Video") {
  static readonly layer = Layer.effect(
    Video,
    Effect.gen(function* () {
      const recorder = yield* Recorder;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const binary = yield* Config.String("GO2RTC_BIN").pipe(
        Config.withDefault("go2rtc"),
      );

      const port = yield* Config.Int("GO2RTC_PORT").pipe(
        Config.withDefault(1984),
      );

      const host = yield* Config.String("DVR_HOST");

      const rtspPort = yield* Config.Int("DVR_RTSP_PORT").pipe(
        Config.withDefault(554),
      );

      // Some recorders keep a separate RTSP login; otherwise it's the same one
      const username = yield* Config.Redacted("DVR_RTSP_USERNAME").pipe(
        Config.orElse(() => Config.Redacted("DVR_USERNAME")),
      );

      const password = yield* Config.Redacted("DVR_RTSP_PASSWORD").pipe(
        Config.orElse(() => Config.Redacted("DVR_PASSWORD")),
      );

      const login = `${encodeURIComponent(Redacted.value(username))}:${encodeURIComponent(Redacted.value(password))}`;

      const rtsp = (channel: number, stream: 0 | 1) =>
        `rtsp://${login}@${host}:${rtspPort}/ch${twoDigits(channel)}/${stream}`;

      // JSON is valid YAML, which is what go2rtc reads.
      const configFor = (channels: number) =>
        JSON.stringify({
          log: { level: "error" },
          // Only the server reaches it, under the same path it serves it on
          api: { listen: `127.0.0.1:${port}`, base_path: basePath },
          rtsp: { listen: "" },
          streams: Object.fromEntries(
            streamsFor(channels).flatMap((stream) => [
              [stream.main, rtsp(stream.channel, 0)],
              [stream.sub, rtsp(stream.channel, 1)],
            ]),
          ),
        });

      const run = Effect.scoped(
        Effect.gen(function* () {
          // The channel count comes from the login, so wait for one.
          const device = yield* recorder.device.pipe(
            Effect.retry(Schedule.spaced(Duration.seconds(5))),
          );

          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "dvr-revival-",
          });

          const file = path.join(directory, "go2rtc.yaml");

          yield* fs.writeFileString(file, configFor(device.channels), {
            mode: 0o600,
          });

          const handle = yield* spawner.spawn(
            ChildProcess.make(binary, ["-config", file], {
              // In the server's own process group, so a supervisor that stops
              // the group, such as Pitchfork, stops go2rtc with it
              detached: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          );

          // go2rtc reads its config once, so it goes as soon as go2rtc
          // answers: the login it holds isn't left on disk even if the
          // server is killed without its cleanup.
          yield* Effect.tryPromise(() =>
            fetch(`http://127.0.0.1:${port}${basePath}/api`),
          ).pipe(
            Effect.retry(
              Schedule.spaced(Duration.millis(200)).pipe(
                Schedule.upTo({ duration: Duration.seconds(10) }),
              ),
            ),
            Effect.ignore,
          );

          yield* fs.remove(file).pipe(Effect.ignore);

          yield* Effect.logInfo(
            `go2rtc is serving ${device.channels} channels on port ${port}`,
          );

          const code = yield* handle.exitCode;

          return yield* Effect.fail(`go2rtc exited with code ${code}`);
        }),
      ).pipe(
        Effect.tapError((error) => Effect.logWarning(String(error))),
        Effect.retry(restart),
      );

      yield* Effect.forkScoped(run);

      return Video.of({
        port,
        sources: recorder.device.pipe(
          Effect.map((device) => ({
            path: `${basePath}/`,
            streams: streamsFor(device.channels),
          })),
        ),
      });
    }),
  );
}
