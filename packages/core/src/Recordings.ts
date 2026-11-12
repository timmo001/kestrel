/**
 * A camera's recordings: each stretch it recorded and why, and the days
 * that have any.
 *
 * @module
 */
import { Schema } from "effect";
import { CameraId } from "./Ids.ts";
import { LocalDate, LocalTime } from "./Times.ts";

/** Why a recording was made. One recording can have several reasons. */
export const RecordingReason = Schema.Literals([
  "normal",
  "alarm",
  "motion",
  "alarm input",
  "PIR",
  "manual",
  "timelapse",
]);

export type RecordingReason = typeof RecordingReason.Type;

/** One stretch a camera recorded, such as a recorder's file. */
export const Recording = Schema.Struct({
  camera: CameraId,
  begin: LocalTime,
  end: LocalTime,
  reasons: Schema.Array(RecordingReason),
  bytes: Schema.NullOr(Schema.Number),
  /** Whether it's only on its source so far, not in the server's recordings folder. */
  remote: Schema.optional(Schema.Boolean),
});

export interface Recording extends Schema.Schema.Type<typeof Recording> {}

/** A day that has recordings, with every reason they were made. */
export const RecordedDay = Schema.Struct({
  date: LocalDate,
  reasons: Schema.Array(RecordingReason),
});

export interface RecordedDay extends Schema.Schema.Type<typeof RecordedDay> {}
