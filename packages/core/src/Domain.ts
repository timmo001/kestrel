/**
 * What a source reports, as Schemas the sources, the server and the web
 * client share. The shapes are the Raysharp recorder's for now, the first
 * source. Times are the source's own local wall-clock time, with no zone, as
 * a recorder keeps them.
 *
 * @module
 */
import { Schema } from "effect";

/** A recorder wall-clock time, such as `2026-11-11T22:24:31`. */
export const LocalTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
);

export type LocalTime = typeof LocalTime.Type;

/** A recorder calendar date, such as `2026-11-11`. */
export const LocalDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
);

export type LocalDate = typeof LocalDate.Type;

/** What the recorder says about itself when it accepts a login. */
export const DeviceInfo = Schema.Struct({
  model: Schema.String,
  name: Schema.String,
  firmware: Schema.String,
  serial: Schema.String,
  mac: Schema.String,
  deviceId: Schema.Number,
  channels: Schema.Number,
  audioChannels: Schema.Number,
  alarmInputs: Schema.Number,
  alarmOutputs: Schema.Number,
  isAdmin: Schema.Boolean,
});

export interface DeviceInfo extends Schema.Schema.Type<typeof DeviceInfo> {}

/** A disk's state, from the recorder's own codes. */
export const DiskState = Schema.Literals([
  "none",
  "ok",
  "unformatted",
  "format error",
  "full",
  "bad",
  "unknown",
]);

export type DiskState = typeof DiskState.Type;

export const Disk = Schema.Struct({
  disk: Schema.Number,
  state: DiskState,
});

export interface Disk extends Schema.Schema.Type<typeof Disk> {}

/** What a channel is recording at the moment, from the recorder's own codes. */
export const RecordingMode = Schema.Literals([
  "stopped",
  "normal",
  "manual",
  "motion",
  "alarm input",
  "motion and alarm input",
  "smart",
  "PIR",
  "motion and PIR",
  "PIR and alarm input",
  "motion, PIR and alarm input",
  "unknown",
]);

export type RecordingMode = typeof RecordingMode.Type;

export const ChannelStatus = Schema.Struct({
  channel: Schema.Number,
  recordingEnabled: Schema.Boolean,
  recording: Schema.Boolean,
  recordingMode: RecordingMode,
  motionEnabled: Schema.Boolean,
  motion: Schema.Boolean,
  videoLoss: Schema.Boolean,
});

export interface ChannelStatus extends Schema.Schema.Type<
  typeof ChannelStatus
> {}

/** The recorder's clock, disks and each channel's state. */
export const RecorderStatus = Schema.Struct({
  time: Schema.NullOr(LocalTime),
  disks: Schema.Array(Disk),
  channels: Schema.Array(ChannelStatus),
});

export interface RecorderStatus extends Schema.Schema.Type<
  typeof RecorderStatus
> {}

/** Why a recording was made. One recording can have several reasons. */
export const RecordingReason = Schema.Literals([
  "normal",
  "alarm",
  "motion",
  "alarm input",
  "PIR",
  "manual",
]);

export type RecordingReason = typeof RecordingReason.Type;

/**
 * A source's id, such as `swann`: lower-case letters, digits and dashes. It
 * never changes, since camera ids, links and saved settings are made from it.
 */
export const SourceId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);

export type SourceId = typeof SourceId.Type;

/**
 * A camera's id: its source's id and its own within that source, such as
 * `swann/3`. Like a source's, it never changes.
 */
export const CameraId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
);

export type CameraId = typeof CameraId.Type;

/** A camera's id from its source's id and its own, such as `swann/3`. */
export const cameraId = (source: SourceId, camera: string): CameraId =>
  `${source}/${camera}`;

/** A camera id's two parts: its source's id and its own within it. */
export const cameraParts = (id: CameraId) => {
  const slash = id.indexOf("/");

  return { source: id.slice(0, slash), camera: id.slice(slash + 1) };
};

/** One recorded file on a recorder's channel, as the recorder lists it. */
export interface ChannelRecording {
  readonly channel: number;
  readonly begin: LocalTime;
  readonly end: LocalTime;
  readonly reasons: ReadonlyArray<RecordingReason>;
  readonly bytes: number | null;
}

/** One recording of a camera's, such as a recorder's file. */
export const Recording = Schema.Struct({
  camera: CameraId,
  begin: LocalTime,
  end: LocalTime,
  reasons: Schema.Array(RecordingReason),
  bytes: Schema.NullOr(Schema.Number),
});

export interface Recording extends Schema.Schema.Type<typeof Recording> {}

/** A day that has recordings, from the month outline. */
export const RecordedDay = Schema.Struct({
  date: LocalDate,
  reasons: Schema.Array(RecordingReason),
});

export interface RecordedDay extends Schema.Schema.Type<typeof RecordedDay> {}

/** The kinds of alarm report the recorder sends once subscribed. */
export const AlarmKind = Schema.Literals([
  "motion",
  "PIR",
  "video loss",
  "alarm input",
  "disk alarm",
  "recording status",
  "disk status",
  "other",
]);

export type AlarmKind = typeof AlarmKind.Type;

/**
 * One alarm report. The layout past the subtype isn't confirmed on this
 * firmware yet, so the raw subtype and size travel with it.
 */
export const AlarmEvent = Schema.Struct({
  kind: AlarmKind,
  subtype: Schema.Number,
  channel: Schema.NullOr(Schema.Number),
  active: Schema.NullOr(Schema.Boolean),
  time: Schema.NullOr(LocalTime),
  size: Schema.Number,
});

export interface AlarmEvent extends Schema.Schema.Type<typeof AlarmEvent> {}

/**
 * An event a source reported, with the time the server received it, in UTC,
 * and the camera it's about, where there is one.
 */
export const ReceivedEvent = Schema.Struct({
  source: SourceId,
  camera: Schema.NullOr(CameraId),
  kind: AlarmKind,
  subtype: Schema.Number,
  active: Schema.NullOr(Schema.Boolean),
  time: Schema.NullOr(LocalTime),
  size: Schema.Number,
  receivedAt: Schema.String,
});

export interface ReceivedEvent extends Schema.Schema.Type<
  typeof ReceivedEvent
> {}

/** Whether the server is connected to a source, and why not. */
export const Connection = Schema.Struct({
  connected: Schema.Boolean,
  since: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

export interface Connection extends Schema.Schema.Type<typeof Connection> {}

/** A source as the API lists it: what it is and whether it's connected. */
export const SourceInfo = Schema.Struct({
  id: SourceId,
  kind: Schema.String,
  name: Schema.String,
  connection: Connection,
  /** Whether it has a device and status to show, as a recorder does. */
  details: Schema.Boolean,
});

export interface SourceInfo extends Schema.Schema.Type<typeof SourceInfo> {}

/** A camera's live streams, by their go2rtc names: the full one and the small sub stream. */
export const LiveStreams = Schema.Struct({
  main: Schema.String,
  sub: Schema.NullOr(Schema.String),
});

export interface LiveStreams extends Schema.Schema.Type<typeof LiveStreams> {}

/**
 * A camera and what it can do. A capability it doesn't have is `null` or
 * `false`, and the page leaves out what needs it.
 */
export const Camera = Schema.Struct({
  id: CameraId,
  source: SourceId,
  name: Schema.String,
  /** A recorder's channel number, for "Ch 3"; `null` for a camera that isn't one. */
  channel: Schema.NullOr(Schema.Number),
  /** Whether the camera has a picture now; `null` when the source can't tell. */
  signal: Schema.NullOr(Schema.Boolean),
  live: Schema.NullOr(LiveStreams),
  recordings: Schema.Boolean,
  events: Schema.Boolean,
});

export interface Camera extends Schema.Schema.Type<typeof Camera> {}

/** The server has no working connection to that source right now. */
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "SourceUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Nothing was recorded on that camera in that range. */
export class NoRecordings extends Schema.TaggedError<NoRecordings>()(
  "NoRecordings",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** No source has that id. */
export class UnknownSource extends Schema.TaggedError<UnknownSource>()(
  "UnknownSource",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** No source has a camera with that id. */
export class UnknownCamera extends Schema.TaggedError<UnknownCamera>()(
  "UnknownCamera",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The source or camera can't do that, such as a stream with no recordings. */
export class NotSupported extends Schema.TaggedError<NotSupported>()(
  "NotSupported",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}
