/**
 * The HTTP server: the API the web client and the CLI read, over the
 * sources.
 *
 * @module
 */
import { BunHttpServer } from "@effect/platform-bun";
import type {
  Camera,
  LiveFeed,
  RecordedDay,
  RecordingReason,
  Source,
  SourceInfo,
} from "@timmo001/kestrel-core";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";
import { Api } from "./Api.ts";
import { Attention } from "./Attention.ts";
import * as Go2rtc from "./Go2rtc.ts";
import { Push } from "./Push.ts";
import { toMp4 } from "./Recordings.ts";
import { capability, Sources } from "./Sources.ts";
import { streamNames, Video } from "./Video.ts";

/** Days from several sources as one list, by date, each with every reason. */
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

const SourcesHandlers = HttpApiBuilder.group(
  Api,
  "sources",
  Effect.fn(function* (handlers) {
    const sources = yield* Sources;
    const attention = yield* Attention;

    const details = (id: string) =>
      sources
        .find(id)
        .pipe(
          Effect.flatMap((source) =>
            capability(source, source.details, "device details"),
          ),
        );

    return handlers
      .handle("list", () =>
        Effect.forEach(sources.all, (source) =>
          source.connection.pipe(
            Effect.map((connection): SourceInfo => ({
              id: source.id,
              kind: source.kind,
              name: source.name,
              connection,
              details: source.details !== undefined,
            })),
          ),
        ),
      )
      .handle("attention", () => attention.list)
      .handle("device", ({ params }) =>
        details(params.source).pipe(Effect.flatMap((each) => each.device)),
      )
      .handle("status", ({ params }) =>
        details(params.source).pipe(Effect.flatMap((each) => each.status)),
      );
  }),
);

/** Every source's cameras, with their stream names; a source that isn't ready yet has none. */
const camerasOf = (source: Source) =>
  Effect.gen(function* () {
    const cameras = yield* source.cameras;

    const feeds = yield* source.live.pipe(
      Effect.orElseSucceed((): ReadonlyArray<LiveFeed> => []),
    );

    return cameras.map((camera): Camera => {
      const feed = feeds.find((each) => each.camera === camera.id);

      return {
        id: camera.id,
        source: source.id,
        name: camera.name,
        channel: camera.channel,
        signal: camera.signal,
        live:
          camera.live && feed !== undefined
            ? streamNames(camera.id, feed.sub !== null)
            : null,
        recordings: camera.recordings && source.recordings !== undefined,
        events: camera.events && source.events !== undefined,
      };
    });
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<Camera> => []));

const CamerasHandlers = HttpApiBuilder.group(
  Api,
  "cameras",
  Effect.fn(function* (handlers) {
    const sources = yield* Sources;

    const recordingsOf = (id: string) =>
      sources
        .find(id)
        .pipe(
          Effect.flatMap((source) =>
            capability(source, source.recordings, "recordings"),
          ),
        );

    return handlers
      .handle("list", () =>
        Effect.forEach(sources.all, camerasOf, {
          concurrency: "unbounded",
        }).pipe(Effect.map((lists) => lists.flat())),
      )
      .handle("recordings", ({ params, query }) =>
        recordingsOf(params.source).pipe(
          Effect.flatMap((recordings) =>
            recordings.list(params.camera, query.date),
          ),
        ),
      )
      .handle("days", ({ query }) =>
        Effect.forEach(
          sources.all.flatMap((source) =>
            source.recordings === undefined ? [] : [source.recordings],
          ),
          (recordings) => recordings.days(query.month),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((lists) => mergeDays(lists.flat()))),
      )
      .handle(
        "video",
        Effect.fnUntraced(function* ({ params, query }) {
          const recordings = yield* recordingsOf(params.source);

          const frames = yield* recordings.video({
            camera: params.camera,
            begin: query.begin,
            end: query.end,
            stream: query.stream ?? "main",
            every: query.every,
          });

          const name = `${params.source}-${params.camera}_${query.begin.replaceAll(":", "-")}.mp4`;

          const disposition =
            query.download === "true" ? "attachment" : "inline";

          return HttpApiSchema.withHeaders({
            // Headers are already sent by the time anything fails, so a
            // failure ends the response early and is only logged
            body: toMp4(frames, query.speedUp ?? 1).pipe(
              Stream.tapError((error) =>
                Effect.logWarning(
                  `Recording ${query.begin} to ${query.end} stopped: ${error.message}`,
                ),
              ),
            ),
            headers: {
              "content-disposition": `${disposition}; filename="${name}"`,
            },
          });
        }),
      );
  }),
);

const EventsHandlers = HttpApiBuilder.group(
  Api,
  "events",
  Effect.fn(function* (handlers) {
    const sources = yield* Sources;

    const events = sources.all.flatMap((source) =>
      source.events === undefined ? [] : [source.events],
    );

    return handlers
      .handle("recent", () =>
        Effect.forEach(events, (each) => each.recent).pipe(
          // Newest first across every source
          Effect.map((lists) =>
            lists
              .flat()
              .toSorted((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
          ),
        ),
      )
      .handle("live", () =>
        Effect.succeed(
          Stream.mergeAll(
            events.map((each) => each.live),
            { concurrency: "unbounded" },
          ),
        ),
      );
  }),
);

const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  Effect.succeed(
    handlers.handle("health", () =>
      HttpMiddleware.withLoggerDisabled(Effect.void),
    ),
  ),
);

/** The API's routes, needing the `Sources` and `Attention`. */
export const routes = HttpApiBuilder.layer(Api, {
  openapiPath: "/api/openapi.json",
}).pipe(
  Layer.provide([
    SourcesHandlers,
    CamerasHandlers,
    EventsHandlers,
    SystemHandlers,
  ]),
);

/**
 * The built web client from `directory`. A path outside the API that names a
 * file gets that file, and any other gets the page, which the service worker
 * and the page's own links work from.
 */
const webClient = (directory: string) =>
  HttpRouter.add("GET", "/*", (request) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pathname = new URL(request.url, "http://localhost").pathname;

      if (pathname === "/api" || pathname.startsWith("/api/")) {
        return HttpServerResponse.empty({ status: 404 });
      }

      const file = path.join(directory, path.normalize(pathname));

      const isFile =
        file.startsWith(`${directory}${path.sep}`) &&
        (yield* fs.stat(file).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        ));

      // Checked with the browser each time, by ETag, so a new build reaches
      // the page and its service worker at once rather than when the
      // browser's own guess at freshness runs out
      return yield* HttpServerResponse.file(
        isFile ? file : path.join(directory, "index.html"),
      ).pipe(
        Effect.map(HttpServerResponse.setHeader("cache-control", "no-cache")),
      );
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          HttpServerResponse.text(
            "The web client isn't built. Run `mise run build`.",
            { status: 503 },
          ),
        ),
      ),
    ),
  );

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
  /** Where the built web client is. */
  readonly web: string;
}

/** go2rtc under `/go2rtc/`, at the port the `Video` service runs it on. */
const go2rtc = Layer.unwrap(
  Effect.gen(function* () {
    const video = yield* Video;

    return Go2rtc.routes(video.port);
  }),
);

/** The push contract's routes, from the `Push` service. */
const push = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Push).routes;
  }),
);

/** Serves the API and the web client over plain HTTP, with the sources behind it. */
export const layer = (options: ServeOptions) =>
  HttpRouter.serve(
    Layer.mergeAll(routes, go2rtc, push, webClient(options.web)),
  ).pipe(
    Layer.provide(
      BunHttpServer.layer({ hostname: options.hostname, port: options.port }),
    ),
    Layer.provide([Video.layer, Attention.layer]),
    Layer.provide(Push.layer),
    // Last, so the routes and the video share one session with each source.
    Layer.provide(Sources.layer),
  );
