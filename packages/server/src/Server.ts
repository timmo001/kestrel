/**
 * The HTTP server: the API the web client reads, over the recorder session.
 *
 * @module
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Api } from "./Api.ts";
import { Attention } from "./Attention.ts";
import * as Go2rtc from "./Go2rtc.ts";
import { Push } from "./Push.ts";
import { Recorder } from "./Recorder.ts";
import { Video } from "./Video.ts";

const RecorderHandlers = HttpApiBuilder.group(
  Api,
  "recorder",
  Effect.fn(function* (handlers) {
    const recorder = yield* Recorder;
    const attention = yield* Attention;

    return handlers
      .handle("connection", () => recorder.connection)
      .handle("attention", () => attention.list)
      .handle("device", () => recorder.device)
      .handle("status", () => recorder.status)
      .handle("recordings", ({ query }) =>
        recorder.recordings(query.channel, query.date),
      )
      .handle("days", ({ query }) => recorder.recordedDays(query.month));
  }),
);

const EventsHandlers = HttpApiBuilder.group(
  Api,
  "events",
  Effect.fn(function* (handlers) {
    const recorder = yield* Recorder;

    return handlers
      .handle("recent", () => recorder.recentEvents)
      .handle("live", () => Effect.succeed(recorder.events));
  }),
);

const VideoHandlers = HttpApiBuilder.group(
  Api,
  "video",
  Effect.fn(function* (handlers) {
    const video = yield* Video;

    return handlers.handle("sources", () => video.sources);
  }),
);

const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  Effect.succeed(
    handlers.handle("health", () =>
      HttpMiddleware.withLoggerDisabled(Effect.void),
    ),
  ),
);

/** The API's routes, needing the `Recorder` and `Video`. */
export const routes = HttpApiBuilder.layer(Api, {
  openapiPath: "/api/openapi.json",
}).pipe(
  Layer.provide([
    RecorderHandlers,
    EventsHandlers,
    VideoHandlers,
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

      return yield* HttpServerResponse.file(
        isFile ? file : path.join(directory, "index.html"),
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

/** Serves the API and the web client over plain HTTP, with the recorder session behind it. */
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

export const layer = (options: ServeOptions) =>
  HttpRouter.serve(
    Layer.mergeAll(routes, go2rtc, push, webClient(options.web)),
  ).pipe(
    Layer.provide(
      BunHttpServer.layer({ hostname: options.hostname, port: options.port }),
    ),
    Layer.provide([Video.layer, Attention.layer]),
    Layer.provide(Push.layer),
    // Last, so the routes and the video share one recorder session.
    Layer.provide(Recorder.layer),
  );
