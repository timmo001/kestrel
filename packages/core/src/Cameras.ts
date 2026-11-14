/**
 * A camera and what it can do. A capability it doesn't have is `null` or
 * `false`, and the page leaves out what needs it.
 *
 * @module
 */
import { Schema } from "effect";
import { CameraControls } from "./Controls.ts";
import { CameraId, SourceId } from "./Ids.ts";

/** A camera's live streams, by their go2rtc names: the full one and the small sub stream. */
export const LiveStreams = Schema.Struct({
  main: Schema.String,
  sub: Schema.NullOr(Schema.String),
  /** The width over height to draw a squeezed sub stream at; `null` for its own shape. */
  subRatio: Schema.NullOr(Schema.Number),
  /** Whether they carry the camera's sound. */
  sound: Schema.Boolean,
  /**
   * Whether they take seconds to start, as a stream looked up afresh each
   * time does, so the page starts them a few at a time, in order.
   */
  slowStart: Schema.Boolean,
});

export interface LiveStreams extends Schema.Schema.Type<typeof LiveStreams> {}

/** One of a camera's pictures, for a camera with more than one, such as a second lens. */
export const CameraView = Schema.Struct({
  /** Its key, such as `telephoto`; the first view's is `main`. */
  key: Schema.String,
  /** Its name, such as `Telephoto`. */
  name: Schema.String,
  live: LiveStreams,
  /** Whether the camera's lens zoom changes this picture. */
  zoom: Schema.Boolean,
});

export interface CameraView extends Schema.Schema.Type<typeof CameraView> {}

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
  /** Its pictures, the main one first, for a camera with more than one; else empty. */
  views: Schema.Array(CameraView),
  controls: CameraControls,
  /** Whether it has a still picture, at `/api/cameras/:source/:camera/still`, for a camera with no video. */
  still: Schema.Boolean,
  recordings: Schema.Boolean,
  events: Schema.Boolean,
});

export interface Camera extends Schema.Schema.Type<typeof Camera> {}
