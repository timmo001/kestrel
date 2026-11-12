/**
 * The server's HTTP API, shared by the server, the web client and the CLI
 * so each side encodes and decodes the same shapes. Each group is named
 * after its path: sources, attention, cameras, recordings, events and the
 * server's health. A camera's routes take its id as two path segments, so
 * `swann/3` reads as itself, such as `/api/cameras/swann/3/recordings`.
 *
 * @module
 */
import {
  Attention,
  Camera,
  CameraEvent,
  CameraKey,
  Details,
  LocalDate,
  LocalMonth,
  LocalTime,
  NoRecordings,
  NotSupported,
  RecordedDay,
  Recording,
  SourceId,
  SourceInfo,
  SourceUnavailable,
  UnknownCamera,
  UnknownSource,
} from "@timmo001/kestrel-core";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

/** Where the server serves go2rtc, which plays every camera live. */
export const go2rtcPath = "/go2rtc/";

/** Which of a camera's streams: the full one or the small sub stream. */
export const RecordedStream = Schema.Literals(["main", "sub"]);

/** A camera's id, as the two path segments of its routes. */
const cameraParams = { source: SourceId, camera: CameraKey };

/** A camera's errors, on top of its own route's. */
const cameraErrors = [
  UnknownSource,
  UnknownCamera,
  NotSupported,
  SourceUnavailable,
] as const;

export class SourcesGroup extends HttpApiGroup.make("sources")
  .add(
    /** Each source, with whether it's connected. */
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(SourceInfo),
    }),
    /** What a source shows about itself, such as a recorder's device, disks and channels. */
    HttpApiEndpoint.get("details", "/:source/details", {
      params: { source: SourceId },
      success: Details,
      error: [UnknownSource, NotSupported, SourceUnavailable],
    }),
  )
  .prefix("/api/sources") {}

export class AttentionGroup extends HttpApiGroup.make("attention")
  .add(
    /** What needs you: the status source the CLI, the page and push read. */
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(Attention),
    }),
  )
  .prefix("/api/attention") {}

export class CamerasGroup extends HttpApiGroup.make("cameras")
  .add(
    /**
     * Every camera and what it can do. A source that isn't connected yet
     * leaves its cameras out until it knows them.
     */
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(Camera),
    }),
    HttpApiEndpoint.get("recordings", "/:source/:camera/recordings", {
      params: cameraParams,
      query: { date: LocalDate },
      success: Schema.Array(Recording),
      error: cameraErrors,
    }),
    /**
     * What a camera recorded between two times, as fragmented MP4 that
     * plays as it arrives. It runs across recordings, with the gaps between
     * them closed up, and starts at the key frame group at `begin`. With
     * `download`, it comes as a file to save.
     */
    HttpApiEndpoint.get("video", "/:source/:camera/video", {
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
      error: [...cameraErrors, NoRecordings],
    }),
  )
  .prefix("/api/cameras") {}

export class RecordingsGroup extends HttpApiGroup.make("recordings")
  .add(
    /** Days with recordings on any camera in a month. */
    HttpApiEndpoint.get("days", "/days", {
      query: { month: LocalMonth },
      success: Schema.Array(RecordedDay),
      error: SourceUnavailable,
    }),
  )
  .prefix("/api/recordings") {}

export class EventsGroup extends HttpApiGroup.make("events")
  .add(
    /** The newest events from every source, newest first. */
    HttpApiEndpoint.get("recent", "/", {
      success: Schema.Array(CameraEvent),
    }),
    /** Events as they arrive, as server-sent events. */
    HttpApiEndpoint.get("live", "/live", {
      success: HttpApiSchema.StreamSse({ data: CameraEvent }),
    }),
  )
  .prefix("/api/events") {}

export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/api/health"),
) {}

export class Api extends HttpApi.make("kestrel")
  .add(SourcesGroup)
  .add(AttentionGroup)
  .add(CamerasGroup)
  .add(RecordingsGroup)
  .add(EventsGroup)
  .add(SystemGroup) {}
