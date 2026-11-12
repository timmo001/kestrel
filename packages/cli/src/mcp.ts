/**
 * The MCP server: the CLI's operations as read-only tools. Failures go back
 * to the client as the tool's result, so an agent can read them and carry on.
 *
 * @module
 */
import { BunStdio } from "@effect/platform-bun";
import {
  Attention,
  Camera,
  CameraEvent,
  cameraParts,
  Details,
  LocalDate,
  LocalMonth,
  RecordedDay,
  Recording,
  Settings,
  SourceId,
  SourceInfo,
} from "@timmo001/kestrel-core";
import { Effect, Layer, Option, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import {
  ClientError,
  resolveCamera,
  resolveSource,
  ServerClient,
} from "./operations.ts";

const Status = Tool.make("status", {
  description:
    "What needs you, and each source's connection, clock, storage and cameras",
  success: Schema.Struct({
    sources: Schema.Array(SourceInfo),
    alerts: Schema.Number,
    attention: Schema.Array(Attention),
    details: Schema.Array(
      Schema.Struct({ source: SourceId, details: Details }),
    ),
  }),
  failure: ClientError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const DetailsTool = Tool.make("details", {
  description:
    "A source's details: its facts, clock, storage and each camera's state",
  parameters: Schema.Struct({
    source: Schema.optional(
      Schema.String.annotate({
        description:
          "The source, such as swann; the only one with details by default",
      }),
    ),
  }),
  success: Details,
  failure: ClientError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Sources = Tool.make("sources", {
  description:
    "Every source's settings and the names given to cameras, as the Settings page shows them, with no secrets",
  success: Settings,
  failure: ClientError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Cameras = Tool.make("cameras", {
  description:
    "Every camera's id, name and what it can do, with its live stream names",
  success: Schema.Struct({ cameras: Schema.Array(Camera) }),
  failure: ClientError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Recordings = Tool.make("recordings", {
  description: "A camera's recordings on one day, with why each was made",
  parameters: Schema.Struct({
    camera: Schema.String.annotate({
      description:
        "The camera's id, such as swann/3; while there's one source, its own id, such as 3",
    }),
    date: LocalDate.annotate({ description: "The day, such as 2026-11-11" }),
  }),
  success: Schema.Struct({ recordings: Schema.Array(Recording) }),
  failure: ClientError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Days = Tool.make("days", {
  description: "The days in a month that have recordings on any camera",
  parameters: Schema.Struct({
    month: LocalMonth.annotate({ description: "The month, such as 2026-11" }),
  }),
  success: Schema.Struct({ days: Schema.Array(RecordedDay) }),
  failure: ClientError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Events = Tool.make("events", {
  description: "The newest events, such as motion and PIR, from every source",
  success: Schema.Struct({ events: Schema.Array(CameraEvent) }),
  failure: ClientError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Tools = Toolkit.make(
  Status,
  DetailsTool,
  Sources,
  Cameras,
  Recordings,
  Days,
  Events,
);

const handlers = Effect.gen(function* () {
  const client = yield* ServerClient;

  return Tools.of({
    status: Effect.fn("mcp.status")(function* () {
      const sources = yield* client.call((api) => api.sources.list());
      const attention = yield* client.call((api) => api.attention.list());

      const details = yield* Effect.forEach(
        sources.filter(
          (source) => source.details && source.connection.connected,
        ),
        (source) =>
          client
            .call((api) =>
              api.sources.details({ params: { source: source.id } }),
            )
            .pipe(
              Effect.map((found) => ({ source: source.id, details: found })),
            ),
      );

      return {
        sources,
        alerts: attention.filter((item) => item.level === "alert").length,
        attention,
        details,
      };
    }),
    details: Effect.fn("mcp.details")(function* ({ source }) {
      const found = yield* resolveSource(Option.fromUndefinedOr(source)).pipe(
        Effect.provideService(ServerClient, client),
      );

      return yield* client.call((api) =>
        api.sources.details({ params: { source: found.id } }),
      );
    }),
    sources: () => client.call((api) => api.sources.settings()),
    cameras: () =>
      client
        .call((api) => api.cameras.list())
        .pipe(Effect.map((list) => ({ cameras: list }))),
    recordings: Effect.fn("mcp.recordings")(function* ({ camera, date }) {
      const id = yield* resolveCamera(camera).pipe(
        Effect.provideService(ServerClient, client),
      );

      const list = yield* client.call((api) =>
        api.cameras.recordings({ params: cameraParts(id), query: { date } }),
      );

      return { recordings: list };
    }),
    days: ({ month }) =>
      client
        .call((api) => api.recordings.days({ query: { month } }))
        .pipe(Effect.map((list) => ({ days: list }))),
    events: () =>
      client
        .call((api) => api.events.recent())
        .pipe(Effect.map((list) => ({ events: list }))),
  });
});

/** Serves the operations over MCP on stdio until the client goes. */
export const serveMcp = McpServer.toolkit(Tools).pipe(
  Layer.provide(Tools.toLayer(handlers)),
  Layer.provide(
    McpServer.layerStdio({
      name: "kestrel",
      version: "0.0.0",
      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
    }),
  ),
  Layer.provide(BunStdio.layer),
  Layer.launch,
);
