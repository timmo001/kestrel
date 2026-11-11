/**
 * The server's HTTP API, shared by the server and the web client so both
 * sides encode and decode the same shapes.
 *
 * @module
 */
import {
  AlarmEvent,
  DeviceInfo,
  LocalDate,
  RecordedDay,
  RecorderStatus,
  Recording,
} from "@timmo001/dvr-revival-rsnet";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

/** The server has no working session with the recorder right now. */
export class RecorderUnavailable extends Schema.TaggedError<RecorderUnavailable>()(
  "RecorderUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** A month, such as `2026-11`. */
export const LocalMonth = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}$/),
);

/** An alarm report with the time the server received it, in UTC. */
export const ReceivedEvent = Schema.Struct({
  ...AlarmEvent.fields,
  receivedAt: Schema.String,
});

export interface ReceivedEvent extends Schema.Schema.Type<
  typeof ReceivedEvent
> {}

/** Whether the server is logged in to the recorder, and why not. */
export const Connection = Schema.Struct({
  connected: Schema.Boolean,
  since: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

export interface Connection extends Schema.Schema.Type<typeof Connection> {}

/** A live stream the web client can play through go2rtc. */
export const LiveStream = Schema.Struct({
  channel: Schema.Number,
  name: Schema.String,
  main: Schema.String,
  sub: Schema.String,
});

export interface LiveStream extends Schema.Schema.Type<typeof LiveStream> {}

/** Where go2rtc listens, on the server's own host, and the streams it has. */
export const VideoSources = Schema.Struct({
  go2rtcPort: Schema.Number,
  streams: Schema.Array(LiveStream),
});

export interface VideoSources extends Schema.Schema.Type<typeof VideoSources> {}

export class RecorderGroup extends HttpApiGroup.make("recorder")
  .add(
    HttpApiEndpoint.get("connection", "/connection", { success: Connection }),
    HttpApiEndpoint.get("device", "/device", {
      success: DeviceInfo,
      error: RecorderUnavailable,
    }),
    HttpApiEndpoint.get("status", "/status", {
      success: RecorderStatus,
      error: RecorderUnavailable,
    }),
    HttpApiEndpoint.get("recordings", "/recordings", {
      query: { channel: Schema.FiniteFromString, date: LocalDate },
      success: Schema.Array(Recording),
      error: RecorderUnavailable,
    }),
    HttpApiEndpoint.get("days", "/days", {
      query: { month: LocalMonth },
      success: Schema.Array(RecordedDay),
      error: RecorderUnavailable,
    }),
  )
  .prefix("/api") {}

export class EventsGroup extends HttpApiGroup.make("events")
  .add(
    HttpApiEndpoint.get("recent", "/", {
      success: Schema.Array(ReceivedEvent),
    }),
    /** Alarm reports as they arrive, as server-sent events. */
    HttpApiEndpoint.get("live", "/live", {
      success: HttpApiSchema.StreamSse({ data: ReceivedEvent }),
    }),
  )
  .prefix("/api/events") {}

export class VideoGroup extends HttpApiGroup.make("video")
  .add(
    HttpApiEndpoint.get("sources", "/sources", {
      success: VideoSources,
      error: RecorderUnavailable,
    }),
  )
  .prefix("/api/video") {}

export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/api/health"),
) {}

export class Api extends HttpApi.make("dvr-revival")
  .add(RecorderGroup)
  .add(EventsGroup)
  .add(VideoGroup)
  .add(SystemGroup) {}
