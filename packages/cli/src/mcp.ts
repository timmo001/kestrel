/**
 * The MCP server: the CLI's operations as read-only tools. Failures go back
 * to the client as the tool's result, so an agent can read them and carry on.
 *
 * @module
 */
import { BunStdio } from "@effect/platform-bun";
import {
  DeviceInfo,
  LocalDate,
  RecordedDay,
  RecorderStatus,
  Recording,
} from "@timmo001/kestrel-rsnet/domain";
import {
  Attention,
  Connection,
  LocalMonth,
  ReceivedEvent,
  VideoSources,
} from "@timmo001/kestrel-server/api";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { Recorder, RecorderError } from "./operations.ts";

const Status = Tool.make("status", {
  description:
    "The recorder's connection, clock, disks and each channel's state",
  success: Schema.Struct({
    connection: Connection,
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

const Recordings = Tool.make("recordings", {
  description: "A channel's recordings on one day, with why each was made",
  parameters: Schema.Struct({
    channel: Schema.Number.annotate({ description: "The channel, from 1" }),
    date: LocalDate.annotate({ description: "The day, such as 2026-11-11" }),
  }),
  success: Schema.Struct({ recordings: Schema.Array(Recording) }),
  failure: RecorderError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Days = Tool.make("days", {
  description: "The days in a month that have recordings",
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

const Video = Tool.make("video", {
  description:
    "Where the server serves go2rtc, and each channel's live stream names",
  success: VideoSources,
  failure: RecorderError,
  failureMode: "return",
}).annotate(Tool.Readonly, true);

const Tools = Toolkit.make(Status, Device, Recordings, Days, Events, Video);

const handlers = Effect.gen(function* () {
  const recorder = yield* Recorder;

  return Tools.of({
    status: Effect.fn("mcp.status")(function* () {
      const connection = yield* recorder.call((api) =>
        api.recorder.connection(),
      );

      const attention = yield* recorder.call((api) => api.recorder.attention());

      return {
        connection,
        alerts: attention.filter((item) => item.level === "alert").length,
        attention,
        status: connection.connected
          ? yield* recorder.call((api) => api.recorder.status())
          : null,
      };
    }),
    device: () => recorder.call((api) => api.recorder.device()),
    recordings: ({ channel, date }) =>
      recorder
        .call((api) => api.recorder.recordings({ query: { channel, date } }))
        .pipe(Effect.map((list) => ({ recordings: list }))),
    days: ({ month }) =>
      recorder
        .call((api) => api.recorder.days({ query: { month } }))
        .pipe(Effect.map((list) => ({ days: list }))),
    events: () =>
      recorder
        .call((api) => api.events.recent())
        .pipe(Effect.map((list) => ({ events: list }))),
    video: () => recorder.call((api) => api.video.sources()),
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
