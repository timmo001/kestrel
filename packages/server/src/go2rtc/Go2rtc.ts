/**
 * The go2rtc process, which plays every camera live. Browsers can't play
 * RTSP, so the server runs go2rtc beside it with every source's live
 * streams, each camera's main and sub stream named from its id, and any
 * other view's, such as a second lens, named after it, and the
 * proxy passes it through under `/go2rtc/`. go2rtc reads its config once, so
 * it starts again whenever the streams change, such as after a save on the
 * Settings page or when a recorder logs in. The config holds the sources'
 * addresses, which can carry their logins, so it's written to a private
 * temporary file rather than passed on the command line, and go2rtc's own
 * logging is kept off.
 *
 * @module
 */
import type {
  CameraId,
  CameraView,
  LiveFeed,
  LiveStreams,
  Source,
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
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Sources } from "../Sources.ts";
import { basePath } from "./Proxy.ts";

const restart = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

/** How often the sources' streams are read again, since a source doesn't say when it's ready. */
const checkEvery = Duration.seconds(5);

/** A camera's main go2rtc stream name, such as `swann_3`. */
export const mainStream = (camera: CameraId) => camera.replace("/", "_");

/** A camera's go2rtc stream names, such as `swann_3` and `swann_3_sub`, and how to draw its sub stream. */
export const streamNames = (feed: LiveFeed): LiveStreams => {
  const main = mainStream(feed.camera);

  return {
    main,
    sub: feed.sub === null ? null : `${main}_sub`,
    subRatio: feed.subRatio ?? null,
    sound: feed.sound === true,
    slowStart: feed.slowStart === true,
  };
};

/**
 * A camera's views, for one with other pictures, with their go2rtc stream
 * names, such as `reolink-hub_1_telephoto`; empty for a camera with one.
 */
export const viewsOf = (feed: LiveFeed): Array<CameraView> =>
  feed.others === undefined || feed.others.length === 0
    ? []
    : [
        {
          key: "main",
          name: feed.view?.name ?? "Main",
          live: streamNames(feed),
          zoom: feed.view?.zoom ?? false,
        },
        ...feed.others.map((other) => {
          const main = `${mainStream(feed.camera)}_${other.key}`;

          return {
            key: other.key,
            name: other.name,
            live: {
              main,
              sub: other.sub === null ? null : `${main}_sub`,
              subRatio: null,
              sound: feed.sound === true,
              slowStart: feed.slowStart === true,
            },
            zoom: other.zoom,
          };
        }),
      ];

/** Each of a camera's go2rtc streams, by name, with where it's read from. */
const streamsOf = (feed: LiveFeed) => {
  const names = streamNames(feed);

  const others = (feed.others ?? []).flatMap((other) => {
    const main = `${names.main}_${other.key}`;

    return other.sub === null
      ? [[main, other.main] as const]
      : [[main, other.main] as const, [`${main}_sub`, other.sub] as const];
  });

  return [
    [names.main, feed.main] as const,
    ...(feed.sub === null ? [] : [[`${names.main}_sub`, feed.sub] as const]),
    ...others,
  ];
};

/**
 * The streams of every source. One that isn't ready keeps the streams it last
 * had, so a source that restarts after a save, such as a recorder logging in
 * again, doesn't drop every live player while it does; one that's never been
 * ready has none.
 */
const feedsOf = (
  all: ReadonlyArray<Source>,
  lastKnown: Map<string, ReadonlyArray<LiveFeed>>,
) =>
  Effect.forEach(
    all,
    (source) =>
      source.live.pipe(
        Effect.tap((feeds) =>
          Effect.sync(() => lastKnown.set(source.id, feeds)),
        ),
        Effect.orElseSucceed(() => lastKnown.get(source.id) ?? []),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((lists) => lists.flat()));

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

      const binary = yield* Config.String("KESTREL_GO2RTC").pipe(
        Config.withDefault("go2rtc"),
      );

      const port = yield* Config.Int("KESTREL_GO2RTC_PORT").pipe(
        Config.withDefault(1984),
      );

      const rtspPort = yield* Config.Int("KESTREL_GO2RTC_RTSP_PORT").pipe(
        Config.withDefault(port + 1),
      );

      const ffmpeg = yield* Config.String("KESTREL_FFMPEG").pipe(
        Config.withDefault("ffmpeg"),
      );

      // JSON is valid YAML, which is what go2rtc reads.
      const configFor = (feeds: ReadonlyArray<LiveFeed>) =>
        JSON.stringify({
          log: { level: "error" },
          // Only the server reaches it, under the same path it serves it on
          api: { listen: `127.0.0.1:${port}`, base_path: basePath },
          // Its ffmpeg and exec sources, such as a stream it transcodes,
          // hand their output back through its RTSP server, so that stays
          // on, where only this machine reaches it
          rtsp: { listen: `127.0.0.1:${rtspPort}` },
          // The ffmpeg the server records with, for streams it copies
          ffmpeg: { bin: ffmpeg },
          streams: Object.fromEntries(
            feeds.flatMap((feed) =>
              streamsOf(feed).map(([name, url]) => [name, Redacted.value(url)]),
            ),
          ),
        });

      const lastKnown = new Map<string, ReadonlyArray<LiveFeed>>();

      /** go2rtc's config each time the streams change. */
      const configs = sources.changes.pipe(
        Stream.switchMap((all) =>
          Stream.fromEffectSchedule(
            feedsOf(all, lastKnown),
            Schedule.spaced(checkEvery),
          ),
        ),
        Stream.map((feeds) => ({
          cameras: feeds.length,
          config: configFor(feeds),
        })),
        Stream.changesWith((a, b) => a.config === b.config),
      );

      /** Runs go2rtc with one config until it exits, starting it again when it does. */
      const run = (cameras: number, config: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "kestrel-",
            });

            const file = path.join(directory, "go2rtc.yaml");

            yield* fs.writeFileString(file, config, { mode: 0o600 });

            const handle = yield* spawner.spawn(
              ChildProcess.make(binary, ["-config", file], {
                // In the server's own process group, so a supervisor that
                // stops the group, such as Pitchfork, stops go2rtc with it
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
              `go2rtc is serving ${cameras} cameras on port ${port}`,
            );

            const code = yield* handle.exitCode;

            return yield* Effect.fail(`go2rtc exited with code ${code}`);
          }),
        ).pipe(
          Effect.tapError((error) => Effect.logWarning(String(error))),
          Effect.retry(restart),
        );

      // A new config stops the go2rtc running the last one first
      yield* configs.pipe(
        Stream.switchMap(({ cameras, config }) =>
          Stream.fromEffect(run(cameras, config)),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );

      return Go2rtc.of({ port });
    }),
  );
}
