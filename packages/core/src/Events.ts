/**
 * Events a source reports, such as motion on a camera, as the server
 * received them.
 *
 * @module
 */
import { Schema } from "effect";
import { CameraId, SourceId } from "./Ids.ts";
import { LocalTime } from "./Times.ts";

/** What happened. */
export const EventKind = Schema.Literals([
  "motion",
  "PIR",
  "person",
  "vehicle",
  "animal",
  "video loss",
  "alarm input",
  "disk alarm",
  "recording status",
  "disk status",
  "other",
]);

export type EventKind = typeof EventKind.Type;

/**
 * An event, with the camera it's about where there is one, the source's own
 * time for it where it gave one, and when the server received it, in UTC.
 */
export const CameraEvent = Schema.Struct({
  source: SourceId,
  camera: Schema.NullOr(CameraId),
  kind: EventKind,
  /** Whether it started or ended; `null` for one that's neither. */
  active: Schema.NullOr(Schema.Boolean),
  time: Schema.NullOr(LocalTime),
  receivedAt: Schema.String,
});

export interface CameraEvent extends Schema.Schema.Type<typeof CameraEvent> {}
