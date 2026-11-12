/**
 * A camera and what it can do. A capability it doesn't have is `null` or
 * `false`, and the page leaves out what needs it.
 *
 * @module
 */
import { Schema } from "effect";
import { CameraId, SourceId } from "./Ids.ts";

/** A camera's live streams, by their go2rtc names: the full one and the small sub stream. */
export const LiveStreams = Schema.Struct({
  main: Schema.String,
  sub: Schema.NullOr(Schema.String),
});

export interface LiveStreams extends Schema.Schema.Type<typeof LiveStreams> {}

export const Camera = Schema.Struct({
  id: CameraId,
  source: SourceId,
  /** Its source's name for it, such as `Channel 3`. */
  name: Schema.String,
  /** The name you gave it, such as `Front door`; `null` until you name it. */
  label: Schema.NullOr(Schema.String),
  /** A recorder's channel number, for "Ch 3"; `null` for a camera that isn't one. */
  channel: Schema.NullOr(Schema.Number),
  /** Whether it has a picture now; `null` when its source can't tell. */
  signal: Schema.NullOr(Schema.Boolean),
  live: Schema.NullOr(LiveStreams),
  recordings: Schema.Boolean,
  events: Schema.Boolean,
});

export interface Camera extends Schema.Schema.Type<typeof Camera> {}
