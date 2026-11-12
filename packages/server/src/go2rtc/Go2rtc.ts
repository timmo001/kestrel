/**
 * The go2rtc process, which plays every camera live. Browsers can't play
 * RTSP, so the server runs go2rtc beside it with every source's live
 * streams, each camera's main and sub stream named from its id, and the
 * proxy passes it through under `/go2rtc/`. The config holds the sources'
 * addresses, which can carry their logins, so it's written to a private
 * temporary file rather than passed on the command line, and go2rtc's own
 * logging is kept off.
 *
 * @module
 */
import type { CameraId, LiveFeed, LiveStreams } from "@timmo001/kestrel-core";
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
import { Sources } from "../Sources.ts";
import { basePath } from "./Proxy.ts";

const restart = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

/** A camera's go2rtc stream names, such as `swann_3` and `swann_3_sub`. */
export const streamNames = (camera: CameraId, hasSub: boolean): LiveStreams => {
  const main = camera.replace("/", "_");

  return { main, sub: hasSub ? `${main}_sub` : null };
};

export class Go2rtc extends Context.Service<
  Go2rtc,
  {
    /** The port go2rtc listens on, on 127.0.0.1. */
    readonly port: number;
  }
>()("@timmo001/kestrel-server/Go2rtc") {
  static readonly layer = Layer.effect(
    Go2rtc,
    Effect.gen(function* () {
      const sources = yield* Sources;
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
            feeds.flatMap((feed) => {
              const names = streamNames(feed.camera, feed.sub !== null);

              return names.sub === null || feed.sub === null
                ? [[names.main, Redacted.value(feed.main)]]
                : [
                    [names.main, Redacted.value(feed.main)],
                    [names.sub, Redacted.value(feed.sub)],
                  ];
            }),
          ),
        });

      const run = Effect.scoped(
        Effect.gen(function* () {
          // Each source's streams come once it's ready, such as after a
          // recorder's login, so wait for them all.
          const feeds = (yield* Effect.forEach(
            sources.all,
            (source) =>
              source.live.pipe(
                Effect.retry(Schedule.spaced(Duration.seconds(5))),
              ),
            { concurrency: "unbounded" },
          )).flat();

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
            `go2rtc is serving ${feeds.length} cameras on port ${port}`,
          );

          const code = yield* handle.exitCode;

          return yield* Effect.fail(`go2rtc exited with code ${code}`);
        }),
      ).pipe(
        Effect.tapError((error) => Effect.logWarning(String(error))),
        Effect.retry(restart),
      );

      yield* Effect.forkScoped(run);

      return Go2rtc.of({ port });
    }),
  );
}
