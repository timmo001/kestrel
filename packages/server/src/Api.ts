/**
 * The server's HTTP API, shared by the server and the web client so both
 * sides encode and decode the same shapes.
 *
 * @module
 */
import {
  Connection,
  DeviceInfo,
  LiveStream,
  LocalDate,
  LocalTime,
  NoRecordings,
  ReceivedEvent,
  RecordedDay,
  RecorderStatus,
  RecorderUnavailable,
  Recording,
} from "@timmo001/kestrel-core/domain";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

/** Which of a channel's streams: the full one or the small sub stream. */
export const RecordedStream = Schema.Literals(["main", "sub"]);

/** A month, such as `2026-11`. */
export const LocalMonth = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}$/),
);

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
         * it; with key frames only (`every`), which come fastest.
         */
        speedUp: Schema.optional(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(4),
          ),
        ),
        /**
         * Key frames only, one per this many seconds of recording, from the
         * recorder's own fast forward: full resolution, far faster than the
         * full stream downloads.
         */
        every: Schema.optional(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(60),
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

export class Api extends HttpApi.make("kestrel")
  .add(RecorderGroup)
  .add(EventsGroup)
  .add(VideoGroup)
  .add(SystemGroup) {}
