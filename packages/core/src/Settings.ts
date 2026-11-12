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

/** How many days of recordings are kept when you haven't said. */
export const defaultRecordingDays = 14;

/** What the server records itself: which cameras, where, and for how long. */
export const RecordingSettings = Schema.Struct({
  /** The cameras it records, by id. */
  cameras: Schema.Array(CameraId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** The folder recordings go in; `null` for `recordings` in the state folder. */
  folder: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** How many days back are kept, besides today. */
  days: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultRecordingDays)),
  ),
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
