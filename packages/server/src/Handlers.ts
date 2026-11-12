/**
 * The API's handlers, a group at a time, over the sources: each finds the
 * source or camera it's asked for, checks the source can do it, and passes
 * the call on.
 *
 * @module
 */
import {
  cameraId,
  type Camera,
  type CameraLabel,
  type LiveFeed,
  type Source,
  type SourceInfo,
} from "@timmo001/kestrel-core";
import { toMp4 } from "@timmo001/kestrel-format-mp4";
import { Effect, Layer, Stream } from "effect";
import { HttpMiddleware, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";
import { Api } from "./Api.ts";
import { Attention } from "./Attention.ts";
import { streamNames } from "./go2rtc/Go2rtc.ts";
import { Library } from "./Library.ts";
import { capability, Sources } from "./Sources.ts";

const SourcesHandlers = HttpApiBuilder.group(
  Api,
  "sources",
  Effect.fn(function* (handlers) {
    const sources = yield* Sources;

    return handlers
      .handle("list", () =>
        sources.all.pipe(
          Effect.flatMap((all) =>
            Effect.forEach(all, (source) =>
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
          ),
        ),
      )
      .handle("kinds", () => Effect.succeed(sources.kinds))
      .handle("settings", () => sources.settings)
      .handle("save", ({ payload }) => sources.save(payload))
      .handle("details", ({ params }) =>
        sources.find(params.source).pipe(
          Effect.flatMap((source) =>
            capability(source, source.details, "details"),
          ),
          Effect.flatten,
        ),
      );
  }),
);

const AttentionHandlers = HttpApiBuilder.group(
  Api,
  "attention",
  Effect.fn(function* (handlers) {
    const attention = yield* Attention;

    return handlers.handle("list", () => attention.list);
  }),
);

/**
 * A source's cameras, with their stream names and labels, and whether the
 * library has recordings of each; a source that isn't ready yet has none.
 */
const camerasOf = (
  source: Source,
  labels: ReadonlyArray<CameraLabel>,
  recorded: ReadonlyArray<string>,
) =>
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
        label: labels.find((each) => each.camera === camera.id)?.label ?? null,
        channel: camera.channel,
        signal: camera.signal,
        live: camera.live && feed !== undefined ? streamNames(feed) : null,
        still: camera.still && source.stills !== undefined,
        recordings: recorded.includes(camera.id),
        events: camera.events && source.events !== undefined,
      };
    });
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<Camera> => []));

const CamerasHandlers = HttpApiBuilder.group(
  Api,
  "cameras",
  Effect.fn(function* (handlers) {
    const sources = yield* Sources;
    const library = yield* Library;

    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const labels = yield* sources.labels;
          const order = yield* sources.order;
          const recorded = yield* library.cameras;

          const lists = yield* Effect.forEach(
            yield* sources.all,
            (source) => camerasOf(source, labels, recorded),
            { concurrency: "unbounded" },
          );

          // Ordered ones first, the rest after in their sources' order
          const placeOf = (camera: Camera) => {
            const at = order.indexOf(camera.id);

            return at === -1 ? order.length : at;
          };

          return lists.flat().toSorted((a, b) => placeOf(a) - placeOf(b));
        }),
      )
      .handle("recordings", ({ params, query }) =>
        library.list(cameraId(params.source, params.camera), query.date),
      )
      .handle(
        "video",
        Effect.fnUntraced(function* ({ params, query }) {
          // Local copies first, then the source for what isn't copied yet
          const frames = yield* library.video({
            camera: cameraId(params.source, params.camera),
            begin: query.begin,
            end: query.end,
            every: query.every,
            stream: query.stream,
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
      )
      .handle("still", ({ params }) =>
        sources.find(params.source).pipe(
          Effect.flatMap((found) =>
            capability(found, found.stills, "still pictures"),
          ),
          Effect.flatMap((stills) =>
            stills.still(cameraId(params.source, params.camera)),
          ),
          // The picture's own type, which needn't be JPEG
          Effect.map((picture) =>
            HttpServerResponse.uint8Array(picture.data, {
              contentType: picture.contentType,
              headers: { "cache-control": "no-store" },
            }),
          ),
        ),
      );
  }),
);

const RecordingsHandlers = HttpApiBuilder.group(
  Api,
  "recordings",
  Effect.fn(function* (handlers) {
    const library = yield* Library;

    return handlers.handle("days", ({ query }) => library.days(query.month));
  }),
);

const EventsHandlers = HttpApiBuilder.group(
  Api,
  "events",
  Effect.fn(function* (handlers) {
    const sources = yield* Sources;

    const eventsOf = (all: ReadonlyArray<Source>) =>
      all.flatMap((source) =>
        source.events === undefined ? [] : [source.events],
      );

    return handlers
      .handle("recent", () =>
        sources.all.pipe(
          Effect.flatMap((all) =>
            Effect.forEach(eventsOf(all), (each) => each.recent),
          ),
          // Newest first across every source
          Effect.map((lists) =>
            lists
              .flat()
              .toSorted((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
          ),
        ),
      )
      .handle("live", () =>
        // Follows the sources as a save changes them
        Effect.succeed(
          sources.changes.pipe(
            Stream.switchMap((all) =>
              Stream.mergeAll(
                eventsOf(all).map((each) => each.live),
                { concurrency: "unbounded" },
              ),
            ),
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
    AttentionHandlers,
    CamerasHandlers,
    RecordingsHandlers,
    EventsHandlers,
    SystemHandlers,
  ]),
);
