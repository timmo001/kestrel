/**
 * How sources are set up: each kind describes the settings it takes, so the
 * app can build its form, and each source is saved as its id, kind, name
 * and those settings, with a label for any camera you've named.
 *
 * @module
 */
import type { Scope } from "effect";
import { Effect, Schema } from "effect";
import type { InvalidSettings } from "./Errors.ts";
import { CameraId, SourceId } from "./Ids.ts";
import type { Source } from "./Source.ts";

/**
 * What a setting holds: plain text, a number, a secret such as a password,
 * which never leaves the server, or a stream's address, which can carry a
 * login and has its password hidden when it's read back.
 */
export const FieldType = Schema.Literals([
  "text",
  "number",
  "secret",
  "address",
]);

export type FieldType = typeof FieldType.Type;

/** One setting a kind of source takes. */
export const SettingField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: FieldType,
  required: Schema.Boolean,
  /** A word on what goes in it, such as what's used when it's left out. */
  hint: Schema.NullOr(Schema.String),
});

export interface SettingField extends Schema.Schema.Type<typeof SettingField> {}

/** A kind of source the server can run, and the settings it takes. */
export const KindInfo = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  description: Schema.String,
  fields: Schema.Array(SettingField),
  /** The settings each camera takes, for a kind you list cameras for yourself; `null` when the source finds its own. */
  cameraFields: Schema.NullOr(Schema.Array(SettingField)),
});

export interface KindInfo extends Schema.Schema.Type<typeof KindInfo> {}

export const SettingValue = Schema.Union([Schema.String, Schema.Number]);

export const SettingValues = Schema.Record(Schema.String, SettingValue);

export type SettingValues = typeof SettingValues.Type;

/** A source as it's saved. */
export const SourceSettings = Schema.Struct({
  id: SourceId,
  kind: Schema.String,
  name: Schema.String,
  settings: SettingValues,
  /** Its cameras' settings, for a kind you list cameras for yourself; empty otherwise. */
  cameras: Schema.Array(SettingValues).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** Read back only: which secret settings are set, since their values aren't sent. */
  secrets: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});

export interface SourceSettings extends Schema.Schema.Type<
  typeof SourceSettings
> {}

/** The name you gave a camera, such as Front door. */
export const CameraLabel = Schema.Struct({
  camera: CameraId,
  label: Schema.String,
});

export interface CameraLabel extends Schema.Schema.Type<typeof CameraLabel> {}

/** How many hours of footage recorded all the time are kept when you haven't said: a week. */
export const defaultContinuousHours = 7 * 24;

/** How many hours of clips, such as motion, are kept when you haven't said: 30 days. */
export const defaultClipHours = 30 * 24;

/** The most of its disk recordings may use when you haven't said, as a percentage. */
export const defaultDiskShare = 10;

/** How fast a copy from a source may read when you haven't said, in MB a second. */
export const defaultCopyRate = 2;

/** The share of the machine's memory kept free when you haven't said, as a percentage. */
export const defaultMemoryFree = 15;

/** The most memory Kestrel may use when you haven't said, in MB. */
export const defaultMemoryLimit = 512;

/** The most of the machine's CPU Kestrel may use when you haven't said, as a percentage. */
export const defaultCpuShare = 50;

/** The lowest and highest each limit may be. */
export const limitRanges = {
  copyRate: { minimum: 0.1, maximum: 1000 },
  memoryFree: { minimum: 0, maximum: 80 },
  memoryLimit: { minimum: 64, maximum: 1_000_000 },
  cpuShare: { minimum: 5, maximum: 100 },
} as const;

const limit = (
  fallback: number,
  range: { readonly minimum: number; readonly maximum: number },
) =>
  Schema.Number.check(Schema.isBetween(range)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(fallback)),
  );

/**
 * How much of the machine background work, such as copying recordings from
 * sources and clearing out old ones, may take. It waits while Kestrel or the
 * machine is past any of them, and carries on after. Live view and
 * Kestrel's own recording never wait.
 */
export const Limits = Schema.Struct({
  /** How fast a copy from a source may read, in MB a second. */
  copyRate: limit(defaultCopyRate, limitRanges.copyRate),
  /** The share of the machine's memory kept free, as a percentage. */
  memoryFree: limit(defaultMemoryFree, limitRanges.memoryFree),
  /** The most memory Kestrel, with go2rtc and ffmpeg, may use, in MB. */
  memoryLimit: limit(defaultMemoryLimit, limitRanges.memoryLimit),
  /** The most of the machine's CPU Kestrel may use, as a percentage. */
  cpuShare: limit(defaultCpuShare, limitRanges.cpuShare),
});

export type Limits = typeof Limits.Type;

/** The limits when you haven't set any. */
export const defaultLimits: Limits = {
  copyRate: defaultCopyRate,
  memoryFree: defaultMemoryFree,
  memoryLimit: defaultMemoryLimit,
  cpuShare: defaultCpuShare,
};

const hours = (fallback: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(fallback)),
  );

/** A number of hours in words, as days when it's whole days, such as `7 days`. */
export const hoursText = (count: number) => {
  if (count % 24 !== 0) return count === 1 ? "1 hour" : `${count} hours`;

  return count === 24 ? "1 day" : `${count / 24} days`;
};

/**
 * What the server records itself and how long recordings are kept: which
 * cameras, where, how many hours of continuous footage and of clips, and
 * how much of the disk they may use. The oldest go first when they'd use
 * more.
 */
export const RecordingSettings = Schema.Struct({
  /** The cameras it records, by id. */
  cameras: Schema.Array(CameraId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** The folder recordings go in; `null` for `recordings` in the state folder. */
  folder: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** How many hours of footage recorded all the time are kept. */
  continuousHours: hours(defaultContinuousHours),
  /** How many hours of clips, recorded for a reason such as motion, are kept. */
  clipHours: hours(defaultClipHours),
  /** The most of its disk the recordings folder may use, as a percentage. */
  diskShare: Schema.Number.check(
    Schema.isBetween({ minimum: 1, maximum: 90 }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultDiskShare))),
  /** How much of the machine background work may take. */
  limits: Limits.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

export interface RecordingSettings extends Schema.Schema.Type<
  typeof RecordingSettings
> {}

/** Every source and camera label, as the sources file keeps them. */
export const Settings = Schema.Struct({
  sources: Schema.Array(SourceSettings),
  cameras: Schema.Array(CameraLabel),
  /**
   * The order cameras are shown in, by id. Cameras it leaves out follow, in
   * the order their sources give them.
   */
  order: Schema.Array(CameraId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** What the server records itself. */
  recording: RecordingSettings.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  /**
   * Which version of the settings these are, as they're read back. A save
   * sends the one it read and is refused when they've changed since, so a
   * page left open can't undo a newer save.
   */
  revision: Schema.optionalKey(Schema.String),
});

export interface Settings extends Schema.Schema.Type<typeof Settings> {}

/** A kind of source: what it takes, and how to start one from its settings. */
export interface Kind {
  readonly info: KindInfo;
  /** Starts a source for as long as the scope lasts. */
  readonly make: (
    settings: SourceSettings,
  ) => Effect.Effect<Source, InvalidSettings, Scope.Scope>;
}

/** A stream address's password hidden, as it's read back. */
export const hiddenPassword = "********";

/** An address with any password in it hidden, such as `rtsp://admin:********@…`. */
export const hidePassword = (address: string) => {
  try {
    const url = new URL(address);

    if (url.password === "") return address;

    url.password = hiddenPassword;

    return url.href;
  } catch {
    return address;
  }
};
