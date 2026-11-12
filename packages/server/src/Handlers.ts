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
  type RecordedDay,
  type RecordingReason,
  type Source,
  type SourceInfo,
} from "@timmo001/kestrel-core";
import { Effect, Layer, Stream } from "effect";
import { HttpMiddleware } from "effect/http";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";
import { Api } from "./Api.ts";
import { Attention } from "./Attention.ts";
import { streamNames } from "./go2rtc/Go2rtc.ts";
import { toMp4 } from "./Mp4.ts";
import { capability, Sources } from "./Sources.ts";

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

/** A source's cameras, with their stream names and labels; a source that isn't ready yet has none. */
const camerasOf = (source: Source, labels: ReadonlyArray<CameraLabel>) =>
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

    /** The recordings of the source a camera's route names. */
    const recordingsOf = (source: string) =>
      sources
        .find(source)
        .pipe(
          Effect.flatMap((found) =>
            capability(found, found.recordings, "recordings"),
          ),
        );

    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const labels = yield* sources.labels;

          const lists = yield* Effect.forEach(
            yield* sources.all,
            (source) => camerasOf(source, labels),
            { concurrency: "unbounded" },
          );

          return lists.flat();
        }),
      )
      .handle("recordings", ({ params, query }) =>
        recordingsOf(params.source).pipe(
          Effect.flatMap((recordings) =>
            recordings.list(cameraId(params.source, params.camera), query.date),
          ),
        ),
      )
      .handle(
        "video",
        Effect.fnUntraced(function* ({ params, query }) {
          const recordings = yield* recordingsOf(params.source);

          const frames = yield* recordings.video({
            camera: cameraId(params.source, params.camera),
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

const RecordingsHandlers = HttpApiBuilder.group(
  Api,
  "recordings",
  Effect.fn(function* (handlers) {
    const sources = yield* Sources;

    return handlers.handle("days", ({ query }) =>
      sources.all.pipe(
        Effect.flatMap((all) =>
          Effect.forEach(
            all.flatMap((source) =>
              source.recordings === undefined ? [] : [source.recordings],
            ),
            (recordings) => recordings.days(query.month),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map((lists) => mergeDays(lists.flat())),
      ),
    );
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
