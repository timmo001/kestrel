/**
 * The server's HTTP API, shared by the server, the web client and the CLI
 * so each side encodes and decodes the same shapes. Each group is named
 * after its path: sources, attention, cameras, recordings, events, the
 * server's health, its jobs and usage, and the paired devices. A camera's routes take its id as two path segments, so
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
  InvalidSettings,
  KindInfo,
  Limits,
  LocalDate,
  LocalMonth,
  LocalTime,
  NoRecordings,
  NotSupported,
  PtzCommand,
  PtzState,
  RecordedDay,
  Recording,
  Settings,
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
    /** The kinds of source the server can run, and the settings each takes. */
    HttpApiEndpoint.get("kinds", "/kinds", {
      success: Schema.Array(KindInfo),
    }),
    /** Every source's settings and the camera labels, with secrets left out. */
    HttpApiEndpoint.get("settings", "/settings", {
      success: Settings,
    }),
    /**
     * Saves every source's settings and the camera labels, keeping each
     * secret left out, and restarts the sources that changed.
     */
    HttpApiEndpoint.put("save", "/settings", {
      payload: Settings,
      success: Settings,
      error: InvalidSettings,
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
    /** A camera's still picture now, as its source sends it, such as a JPEG. */
    HttpApiEndpoint.get("still", "/:source/:camera/still", {
      params: cameraParams,
      success: Schema.Uint8Array.pipe(
        HttpApiSchema.asUint8Array({ contentType: "image/jpeg" }),
      ),
      error: cameraErrors,
    }),
    /**
     * Where a camera that moves has its lens zoomed, its presets, its home
     * and how it follows what it sees.
     */
    HttpApiEndpoint.get("ptz", "/:source/:camera/ptz", {
      params: cameraParams,
      success: PtzState,
      error: cameraErrors,
    }),
    /**
     * Tells a camera to move, stop, zoom or go to a preset; saves, renames
     * or clears a preset; sends it home or makes where it points home; or
     * changes how it goes home or follows what it sees. A camera that's
     * moving stops by itself unless it's told to move again within a second.
     */
    HttpApiEndpoint.post("steer", "/:source/:camera/ptz", {
      params: cameraParams,
      payload: PtzCommand,
      error: cameraErrors,
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

/** One look at how much of the machine Kestrel and everything else uses. */
export const UsageSample = Schema.Struct({
  /** When, in milliseconds since 1970. */
  at: Schema.Number,
  /** The machine's memory in all, in bytes, or the container's when it has a limit. */
  memory: Schema.Number,
  /** How much of it is free for use, in bytes. */
  memoryFree: Schema.Number,
  /** How much swap is in use, in bytes. */
  swapUsed: Schema.Number,
  /**
   * The share of the last 10 seconds something on the machine waited for
   * memory, as a percentage, from Linux's pressure figures; 0 without them.
   */
  memoryPressure: Schema.Number,
  /** The same for the disk. */
  diskPressure: Schema.Number,
  /** The machine's CPU cores. */
  cores: Schema.Number,
  /** The machine's load over the last minute. */
  load: Schema.Number,
  /** The memory Kestrel uses, with go2rtc and ffmpeg, in bytes. */
  kestrelMemory: Schema.Number,
  /** The CPU Kestrel uses, with go2rtc and ffmpeg, as a percentage of one core. */
  kestrelCpu: Schema.Number,
});

export type UsageSample = typeof UsageSample.Type;

/** One of Kestrel's processes: the server, go2rtc or an ffmpeg. */
export const ProcessUsage = Schema.Struct({
  name: Schema.String,
  /** In bytes. */
  memory: Schema.Number,
  /** As a percentage of one core. */
  cpu: Schema.Number,
});

export type ProcessUsage = typeof ProcessUsage.Type;

/** What a camera's recordings use in the recordings folder. */
export const StoredCamera = Schema.Struct({
  camera: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
});

export type StoredCamera = typeof StoredCamera.Type;

/** The disk the recordings folder is on, and what's in it. */
export const DiskUsage = Schema.Struct({
  folder: Schema.String,
  /** In bytes. */
  total: Schema.Number,
  free: Schema.Number,
  /** What recordings use, as of the last count. */
  recordings: Schema.Number,
  /**
   * What recordings may use in all, in bytes: the disk share from Settings,
   * or less where that would leave the disk too full.
   */
  allowed: Schema.optional(Schema.Number),
  /** The disk share recordings may use from Settings, as a percentage. */
  diskShare: Schema.optional(Schema.Number),
  cameras: Schema.Array(StoredCamera),
  /** When recordings were last counted, as an ISO time. */
  counted: Schema.optional(Schema.String),
});

export type DiskUsage = typeof DiskUsage.Type;

/**
 * How much of the machine Kestrel uses now and over the last hour, against
 * the limits background work keeps to.
 */
export const UsageReport = Schema.Struct({
  limits: Limits,
  /** Why background work is waiting now, if it is. */
  holdUp: Schema.optional(Schema.String),
  now: UsageSample,
  processes: Schema.Array(ProcessUsage),
  disk: Schema.optional(DiskUsage),
  /** The last hour, oldest first. */
  history: Schema.Array(UsageSample),
});

export type UsageReport = typeof UsageReport.Type;

/** What a job does now: nothing until it's next due, working, waiting for room, or stopped by an error. */
export const JobState = Schema.Literals([
  "idle",
  "running",
  "waiting",
  "failed",
]);

export type JobState = typeof JobState.Type;

/** A recording a copy brought over from a source. */
export const CopiedRecording = Schema.Struct({
  camera: Schema.String,
  /** When it starts, by the source's local time. */
  begin: Schema.String,
  bytes: Schema.Number,
  /** When it was copied, as an ISO time. */
  at: Schema.String,
});

export type CopiedRecording = typeof CopiedRecording.Type;

/** How a copy is getting on with one source's recordings. */
export const CopySource = Schema.Struct({
  source: Schema.String,
  copied: Schema.Number,
  /** Still to copy in this pass. */
  left: Schema.Number,
  /** Copied in this pass, in bytes. */
  bytes: Schema.Number,
});

export type CopySource = typeof CopySource.Type;

/**
 * Work the server does by itself: copying recordings from sources,
 * recording a camera, or clearing out old recordings.
 */
export const Job = Schema.Struct({
  /** Such as `copy`, `clear-out` or `record:swann/3`. */
  id: Schema.String,
  kind: Schema.Literals(["copy", "record", "clear-out"]),
  name: Schema.String,
  state: JobState,
  /** What it's doing or waiting for, in a few words. */
  detail: Schema.String,
  /** When it went into its state, as an ISO time. */
  since: Schema.String,
  /** How far through this pass it is. */
  progress: Schema.optional(
    Schema.Struct({
      done: Schema.Number,
      total: Schema.Number,
      bytes: Schema.Number,
    }),
  ),
  /** A copy's sources, in this pass. */
  sources: Schema.optional(Schema.Array(CopySource)),
  /** A copy's newest recordings, newest first. */
  recent: Schema.optional(Schema.Array(CopiedRecording)),
  lastRun: Schema.optional(
    Schema.Struct({ at: Schema.String, summary: Schema.String }),
  ),
  lastError: Schema.optional(
    Schema.Struct({ at: Schema.String, message: Schema.String }),
  ),
});

export type Job = typeof Job.Type;

/** How much an activity log entry matters. */
export const LogLevel = Schema.Literals(["info", "error"]);

export type LogLevel = typeof LogLevel.Type;

/**
 * One line of the activity log: a job's error or finished run. The server
 * keeps the last 7 days, up to 5 MB.
 */
export const LogEntry = Schema.Struct({
  /** When, as an ISO time. */
  at: Schema.String,
  /** The job's id, such as `copy` or `record:swann/3`. */
  job: Schema.String,
  /** The job's name, such as `Copy recordings from sources`. */
  name: Schema.String,
  level: LogLevel,
  message: Schema.String,
});

export type LogEntry = typeof LogEntry.Type;

/** What the server does by itself, and how much of the machine it uses. */
export class ActivityGroup extends HttpApiGroup.make("activity")
  .add(
    /** Each job, with what it's doing and how it's getting on. */
    HttpApiEndpoint.get("jobs", "/jobs", { success: Schema.Array(Job) }),
    /** Kestrel's use of memory, CPU and disk, now and over the last hour. */
    HttpApiEndpoint.get("usage", "/usage", { success: UsageReport }),
    /**
     * The activity log, newest first: the last `limit` entries, 200 by
     * default, optionally of one job or level.
     */
    HttpApiEndpoint.get("log", "/log", {
      query: {
        job: Schema.optional(Schema.String),
        level: Schema.optional(LogLevel),
        limit: Schema.optional(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(5000),
          ),
        ),
      },
      success: Schema.Array(LogEntry),
    }),
  )
  .prefix("/api/activity") {}

/** What a paired device is, which says how it signs in: a cookie for a browser, a token for the rest. */
export const DeviceKind = Schema.Literals([
  "browser",
  "desktop",
  "cli",
  "android",
]);

export type DeviceKind = typeof DeviceKind.Type;

/** A device paired with the server. */
export const Device = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: DeviceKind,
  /** When it paired, as an ISO time. */
  pairedAt: Schema.String,
  /** When it last used the server, as an ISO time. */
  lastSeen: Schema.optional(Schema.String),
});

export interface Device extends Schema.Schema.Type<typeof Device> {}

/**
 * The server, as a device sees it: an id that stays the same when its
 * address changes, its name, and its version, which a client must match.
 */
export const ServerInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
});

export interface ServerInfo extends Schema.Schema.Type<typeof ServerInfo> {}

/** A one-time code to pair a device with. */
export const PairingCode = Schema.Struct({
  /** Such as `ABCD-EFGH`. */
  code: Schema.String,
  /** When it stops working, as an ISO time. */
  expires: Schema.String,
  /**
   * The page that pairs with it, for a QR code, or nothing when the server
   * has no address other devices can reach.
   */
  link: Schema.optional(Schema.String),
});

export interface PairingCode extends Schema.Schema.Type<typeof PairingCode> {}

export const PairRequest = Schema.Struct({
  code: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  kind: DeviceKind,
});

export interface PairRequest extends Schema.Schema.Type<typeof PairRequest> {}

/** A device that just paired, with its token, shown this once. A browser gets a cookie instead. */
export const Paired = Schema.Struct({
  device: Device,
  server: ServerInfo,
  token: Schema.optional(Schema.String),
});

export interface Paired extends Schema.Schema.Type<typeof Paired> {}

/** A one-time path, under the server's address, that signs a window in as the device that asked for it. */
export const SignInLink = Schema.Struct({ path: Schema.String });

export interface SignInLink extends Schema.Schema.Type<typeof SignInLink> {}

/** A code that's wrong, used or past its time. */
export class PairingRefused extends Schema.TaggedError<PairingRefused>()(
  "PairingRefused",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** The request came from a device that isn't paired, which every route but pairing answers with. */
export class Unpaired extends Schema.TaggedError<Unpaired>()(
  "Unpaired",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/**
 * The client runs another version of Kestrel than the server, which every
 * route but the server's health and info answers with.
 */
export class VersionMismatch extends Schema.TaggedError<VersionMismatch>()(
  "VersionMismatch",
  { message: Schema.String, server: Schema.String, client: Schema.String },
  { httpApiStatus: 426 },
) {}

/** No paired device has that id. */
export class UnknownDevice extends Schema.TaggedError<UnknownDevice>()(
  "UnknownDevice",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Where a device pairs, and the paired devices. */
export class DevicesGroup extends HttpApiGroup.make("devices")
  .add(
    /** The server's id and name. Open to anyone, so a device can tell which server it found. */
    HttpApiEndpoint.get("server", "/server", { success: ServerInfo }),
    /** Pairs a device with a code. Open to anyone; the code is the proof. */
    HttpApiEndpoint.post("pair", "/pair", {
      payload: PairRequest,
      success: Paired,
      error: PairingRefused,
    }),
    /** A new one-time code for another device to pair with. */
    HttpApiEndpoint.post("code", "/code", { success: PairingCode }),
    /** A one-time sign-in path for a window, as the device asking. */
    HttpApiEndpoint.post("link", "/link", {
      success: SignInLink,
      error: PairingRefused,
    }),
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(Device) }),
    /** Unpairs a device, so its token and its windows stop working. */
    HttpApiEndpoint.delete("revoke", "/:id", {
      params: { id: Schema.String },
      error: UnknownDevice,
    }),
  )
  .prefix("/api/devices") {}

export class Api extends HttpApi.make("kestrel")
  .add(SourcesGroup)
  .add(AttentionGroup)
  .add(CamerasGroup)
  .add(RecordingsGroup)
  .add(EventsGroup)
  .add(SystemGroup)
  .add(ActivityGroup)
  .add(DevicesGroup) {}

/** The cookie a paired browser signs in with. */
export const sessionCookie = "kestrel_session";

/** Where a one-time sign-in path starts, under the server's address. */
export const connectPath = "auth/connect/";
