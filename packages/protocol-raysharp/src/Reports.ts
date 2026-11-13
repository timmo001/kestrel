/**
 * What a Raysharp recorder reports, from its own codes: its device, its
 * status (clock, disks and each channel), its recorded files by channel and
 * its alarm reports. Times are the recorder's own clock, with no zone.
 *
 * @module
 */
import { LocalTime, type RecordingReason } from "@timmo001/kestrel-core";
import { Schema } from "effect";

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

/** One recorded file on a channel, as the recorder lists it. */
export interface ChannelRecording {
  readonly channel: number;
  readonly begin: LocalTime;
  readonly end: LocalTime;
  readonly reasons: ReadonlyArray<RecordingReason>;
  readonly bytes: number | null;
}

/**
 * A channel's colour, from the colour parameter page. Hue, brightness,
 * contrast and saturation run from 0 to `range`; sharpness always runs to
 * 255.
 */
export interface ChannelColour {
  readonly channel: number;
  readonly hue: number;
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly sharpness: number;
  readonly range: 63 | 255;
  /** Whether the recorder offers to put it back to its defaults. */
  readonly resettable: boolean;
  /** The page's whole 96-byte entry, so a save sends back what it doesn't change. */
  readonly entry: Uint8Array;
}

/** Colour values to save, each in the channel's own range. */
export interface ColourChange {
  readonly hue?: number | undefined;
  readonly brightness?: number | undefined;
  readonly contrast?: number | undefined;
  readonly saturation?: number | undefined;
  readonly sharpness?: number | undefined;
}

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
export interface AlarmEvent {
  readonly kind: AlarmKind;
  readonly subtype: number;
  readonly channel: number | null;
  readonly active: boolean | null;
  readonly time: LocalTime | null;
  readonly size: number;
}
