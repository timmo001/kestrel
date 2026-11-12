/**
 * The server's HTTP API, shared by the server, the web client and the CLI
 * so each side encodes and decodes the same shapes. It serves sources and
 * their cameras: a camera's routes take its id as two path segments, so
 * `swann/3` reads as itself, such as `/api/cameras/swann/3/recordings`.
 *
 * @module
 */
import {
  Camera,
  DeviceInfo,
  LocalDate,
  LocalTime,
  NoRecordings,
  NotSupported,
  ReceivedEvent,
  RecordedDay,
  RecorderStatus,
  Recording,
  SourceId,
  SourceInfo,
  SourceUnavailable,
  UnknownCamera,
  UnknownSource,
} from "@timmo001/kestrel-core/domain";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

/** Where the server serves go2rtc, which plays every camera's live streams. */
export const go2rtcPath = "/go2rtc/";

/** Which of a camera's streams: the full one or the small sub stream. */
export const RecordedStream = Schema.Literals(["main", "sub"]);

/** A month, such as `2026-11`. */
export const LocalMonth = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}$/),
);

/** A camera's id within its source, such as `3` in `swann/3`. */
const CameraKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));

/** A camera's id, as the two path segments of its routes. */
const cameraParams = { source: SourceId, camera: CameraKey };

/**
 * Something about a source that needs you. An alert is pushed and counted;
 * a passive one is only listed.
 */
export const Attention = Schema.Struct({
  source: SourceId,
  level: Schema.Literals(["alert", "passive"]),
  kind: Schema.Literals(["connection", "disk", "signal"]),
  message: Schema.String,
});

export interface Attention extends Schema.Schema.Type<typeof Attention> {}

export class SourcesGroup extends HttpApiGroup.make("sources")
  .add(
    /** Each source, with whether it's connected. */
    HttpApiEndpoint.get("list", "/sources", {
      success: Schema.Array(SourceInfo),
    }),
    /** What needs you: the status source the CLI, the page and push read. */
    HttpApiEndpoint.get("attention", "/attention", {
      success: Schema.Array(Attention),
    }),
    HttpApiEndpoint.get("device", "/sources/:source/device", {
      params: { source: SourceId },
      success: DeviceInfo,
      error: [UnknownSource, NotSupported, SourceUnavailable],
    }),
    HttpApiEndpoint.get("status", "/sources/:source/status", {
      params: { source: SourceId },
      success: RecorderStatus,
      error: [UnknownSource, NotSupported, SourceUnavailable],
    }),
  )
  .prefix("/api") {}

export class CamerasGroup extends HttpApiGroup.make("cameras")
  .add(
    /**
     * Every camera and what it can do. A source that isn't connected yet
     * leaves its cameras out until it knows them.
     */
    HttpApiEndpoint.get("list", "/cameras", {
      success: Schema.Array(Camera),
    }),
    HttpApiEndpoint.get("recordings", "/cameras/:source/:camera/recordings", {
      params: cameraParams,
      query: { date: LocalDate },
      success: Schema.Array(Recording),
      error: [UnknownSource, UnknownCamera, NotSupported, SourceUnavailable],
    }),
    /**
     * What a camera recorded between two times, as fragmented MP4 that
     * plays as it arrives. It runs across files, with the gaps between
     * them closed up, and starts at the key frame group at `begin`. With
     * `download`, it comes as a file to save.
     */
    HttpApiEndpoint.get("video", "/cameras/:source/:camera/video", {
      params: cameraParams,
      query: {
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
      error: [
        UnknownSource,
        UnknownCamera,
        NotSupported,
        SourceUnavailable,
        NoRecordings,
      ],
    }),
    /** Days with recordings on any camera in a month. */
    HttpApiEndpoint.get("days", "/days", {
      query: { month: LocalMonth },
      success: Schema.Array(RecordedDay),
      error: SourceUnavailable,
    }),
  )
  .prefix("/api") {}

export class EventsGroup extends HttpApiGroup.make("events")
  .add(
    HttpApiEndpoint.get("recent", "/", {
      success: Schema.Array(ReceivedEvent),
    }),
    /** Events as they arrive, as server-sent events. */
    HttpApiEndpoint.get("live", "/live", {
      success: HttpApiSchema.StreamSse({ data: ReceivedEvent }),
    }),
  )
  .prefix("/api/events") {}

export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/api/health"),
) {}

export class Api extends HttpApi.make("kestrel")
  .add(SourcesGroup)
  .add(CamerasGroup)
  .add(EventsGroup)
  .add(SystemGroup) {}
