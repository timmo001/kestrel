/**
 * The HTTP server: the API the web client reads, over the recorder session.
 *
 * @module
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Api } from "./Api.ts";
import { Recorder } from "./Recorder.ts";
import { Video } from "./Video.ts";

const RecorderHandlers = HttpApiBuilder.group(
  Api,
  "recorder",
  Effect.fn(function* (handlers) {
    const recorder = yield* Recorder;

    return handlers
      .handle("connection", () => recorder.connection)
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

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
}

/** Serves the API over plain HTTP, with the recorder session behind it. */
export const layer = (options: ServeOptions) =>
  HttpRouter.serve(routes).pipe(
    Layer.provide(BunHttpServer.layer(options)),
    Layer.provide(Video.layer),
    // Last, so the routes and the video share one recorder session.
    Layer.provide(Recorder.layer),
  );
