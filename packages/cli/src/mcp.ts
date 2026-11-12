/**
 * The MCP server: the CLI's operations as read-only tools. Failures go back
 * to the client as the tool's result, so an agent can read them and carry on.
 *
 * @module
 */
import { BunStdio } from "@effect/platform-bun";
import {
  Camera,
  cameraParts,
  DeviceInfo,
  LocalDate,
  ReceivedEvent,
  RecordedDay,
  RecorderStatus,
  Recording,
  SourceInfo,
} from "@timmo001/kestrel-core/domain";
import { Attention, LocalMonth } from "@timmo001/kestrel-server/api";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import {
  Recorder,
  RecorderError,
  recorderSource,
  resolveCamera,
} from "./operations.ts";

const Status = Tool.make("status", {
  description:
    "What needs you, each source's connection, and the recorder's clock, disks and each channel's state",
  success: Schema.Struct({
    sources: Schema.Array(SourceInfo),
    alerts: Schema.Number,
    attention: Schema.Array(Attention),
    status: Schema.NullOr(RecorderStatus),
  }),
  failure: RecorderError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Device = Tool.make("device", {
  description: "The recorder's name, firmware and channel count",
  success: DeviceInfo,
  failure: RecorderError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Cameras = Tool.make("cameras", {
  description:
    "Every camera's id, name and what it can do, with its live stream names",
  success: Schema.Struct({ cameras: Schema.Array(Camera) }),
  failure: RecorderError,
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
  failure: RecorderError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Days = Tool.make("days", {
  description: "The days in a month that have recordings on any camera",
  parameters: Schema.Struct({
    month: LocalMonth.annotate({ description: "The month, such as 2026-11" }),
  }),
  success: Schema.Struct({ days: Schema.Array(RecordedDay) }),
  failure: RecorderError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Events = Tool.make("events", {
  description: "The newest motion, PIR, video loss and disk reports",
  success: Schema.Struct({ events: Schema.Array(ReceivedEvent) }),
  failure: RecorderError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Tools = Toolkit.make(Status, Device, Cameras, Recordings, Days, Events);

const handlers = Effect.gen(function* () {
  const recorder = yield* Recorder;

  return Tools.of({
    status: Effect.fn("mcp.status")(function* () {
      const sources = yield* recorder.call((api) => api.sources.list());
      const attention = yield* recorder.call((api) => api.sources.attention());

      const withDetails = sources.find(
        (source) => source.details && source.connection.connected,
      );

      return {
        sources,
        alerts: attention.filter((item) => item.level === "alert").length,
        attention,
        status:
          withDetails === undefined
            ? null
            : yield* recorder.call((api) =>
                api.sources.status({ params: { source: withDetails.id } }),
              ),
      };
    }),
    device: Effect.fn("mcp.device")(function* () {
      const source = yield* recorderSource().pipe(
        Effect.provideService(Recorder, recorder),
      );

      return yield* recorder.call((api) =>
        api.sources.device({ params: { source: source.id } }),
      );
    }),
    cameras: () =>
      recorder
        .call((api) => api.cameras.list())
        .pipe(Effect.map((list) => ({ cameras: list }))),
    recordings: Effect.fn("mcp.recordings")(function* ({ camera, date }) {
      const id = yield* resolveCamera(camera).pipe(
        Effect.provideService(Recorder, recorder),
      );

      const list = yield* recorder.call((api) =>
        api.cameras.recordings({ params: cameraParts(id), query: { date } }),
      );

      return { recordings: list };
    }),
    days: ({ month }) =>
      recorder
        .call((api) => api.cameras.days({ query: { month } }))
        .pipe(Effect.map((list) => ({ days: list }))),
    events: () =>
      recorder
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
