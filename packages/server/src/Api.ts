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
  LocalTime,
  RecordedDay,
  RecorderStatus,
  Recording,
} from "@timmo001/dvr-revival-rsnet/domain";
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

/** Nothing was recorded on that channel in that range. */
export class NoRecordings extends Schema.TaggedError<NoRecordings>()(
  "NoRecordings",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Which of a channel's streams: the full one or the small sub stream. */
export const RecordedStream = Schema.Literals(["main", "sub"]);

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

/**
 * Something about the recorder that needs you. An alert is pushed and
 * counted; a passive one is only listed.
 */
export const Attention = Schema.Struct({
  level: Schema.Literals(["alert", "passive"]),
  kind: Schema.Literals(["connection", "disk", "signal"]),
  message: Schema.String,
});

export interface Attention extends Schema.Schema.Type<typeof Attention> {}

/** A live stream the web client can play through go2rtc. */
export const LiveStream = Schema.Struct({
  channel: Schema.Number,
  name: Schema.String,
  main: Schema.String,
  sub: Schema.String,
});

export interface LiveStream extends Schema.Schema.Type<typeof LiveStream> {}

/** The path the server serves go2rtc under, and the streams it has. */
export const VideoSources = Schema.Struct({
  path: Schema.String,
  streams: Schema.Array(LiveStream),
});

export interface VideoSources extends Schema.Schema.Type<typeof VideoSources> {}

export class RecorderGroup extends HttpApiGroup.make("recorder")
  .add(
    HttpApiEndpoint.get("connection", "/connection", { success: Connection }),
    /** What needs you: the status source the CLI, the page and push read. */
    HttpApiEndpoint.get("attention", "/attention", {
      success: Schema.Array(Attention),
    }),
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
    /**
     * What a channel recorded between two recorder times, as fragmented MP4
     * that plays as it arrives. It runs across files, with the gaps between
     * them closed up, and starts at the key frame group at `begin`. With
     * `download`, it comes as a file to save.
     */
    HttpApiEndpoint.get("video", "/recordings/video", {
      query: {
        channel: Schema.FiniteFromString,
        begin: LocalTime,
        end: LocalTime,
        stream: Schema.optional(RecordedStream),
        download: Schema.optional(Schema.Literals(["true", "false"])),
        /**
         * Plays this many times faster than it was recorded, each frame
         * shortened to match. Browsers stop at 16 times, so this goes past
         * it; with the sub stream, which downloads fastest.
         */
        speedUp: Schema.optional(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(4),
          ),
        ),
      },
      success: HttpApiSchema.WithHeaders(
        HttpApiSchema.StreamUint8Array({ contentType: "video/mp4" }),
        { "content-disposition": Schema.String },
      ),
      error: [RecorderUnavailable, NoRecordings],
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
