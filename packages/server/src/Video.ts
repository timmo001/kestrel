/**
 * Live video through go2rtc. Browsers can't play RTSP, so the server runs
 * go2rtc beside it with the source's live streams, each channel's main and
 * sub stream, and the web client plays them through the server, under
 * `/go2rtc/`. The config holds the source's addresses, which can carry its
 * login, so it's written to a private temporary file rather than passed on
 * the command line, and go2rtc's own logging is kept off.
 *
 * @module
 */
import {
  Recorder,
  type LiveFeed,
  type RecorderUnavailable,
} from "@timmo001/kestrel-core";
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
import type { VideoSources } from "./Api.ts";
import { basePath } from "./Go2rtc.ts";

const restart = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

export class Video extends Context.Service<
  Video,
  {
    /** The port go2rtc listens on, on 127.0.0.1. */
    readonly port: number;
    readonly sources: Effect.Effect<VideoSources, RecorderUnavailable>;
  }
>()("@timmo001/kestrel-server/Video") {
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

      // JSON is valid YAML, which is what go2rtc reads.
      const configFor = (feeds: ReadonlyArray<LiveFeed>) =>
        JSON.stringify({
          log: { level: "error" },
          // Only the server reaches it, under the same path it serves it on
          api: { listen: `127.0.0.1:${port}`, base_path: basePath },
          rtsp: { listen: "" },
          streams: Object.fromEntries(
            feeds.flatMap((feed) => [
              [feed.stream.main, Redacted.value(feed.main)],
              [feed.stream.sub, Redacted.value(feed.sub)],
            ]),
          ),
        });

      const run = Effect.scoped(
        Effect.gen(function* () {
          // The streams come from the source once it's ready, such as after
          // a recorder's login, so wait for them.
          const feeds = yield* recorder.live.pipe(
            Effect.retry(Schedule.spaced(Duration.seconds(5))),
          );

          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "kestrel-",
          });

          const file = path.join(directory, "go2rtc.yaml");

          yield* fs.writeFileString(file, configFor(feeds), {
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
            `go2rtc is serving ${feeds.length} channels on port ${port}`,
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
        sources: recorder.live.pipe(
          Effect.map((feeds) => ({
            path: `${basePath}/`,
            streams: feeds.map((feed) => feed.stream),
          })),
        ),
      });
    }),
  );
}
