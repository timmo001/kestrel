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

/** One recorded file on a channel. */
export const Recording = Schema.Struct({
  channel: Schema.Number,
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
