/**
 * What a source shows about itself, kept general so any source can fill it
 * in: labelled facts, its storage, and each camera's state now. Also what
 * needs you about it, which each source works out for itself.
 *
 * @module
 */
import { Schema } from "effect";
import { CameraId, SourceId } from "./Ids.ts";
import { LocalTime } from "./Times.ts";

/** A labelled value, such as Firmware and its version. */
export const Fact = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
});

export interface Fact extends Schema.Schema.Type<typeof Fact> {}

/** A disk or card the source records to, with its state in words and whether that's fine. */
export const Storage = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  ok: Schema.Boolean,
});

export interface Storage extends Schema.Schema.Type<typeof Storage> {}

/** A camera's state now, as its source sees it. */
export const CameraState = Schema.Struct({
  camera: CameraId,
  /** Whether it has a picture; `null` when the source can't tell. */
  signal: Schema.NullOr(Schema.Boolean),
  /** What it's recording, in words, such as `motion` or `stopped`. */
  recording: Schema.String,
  /** Whether there's motion now; `null` when the source can't tell. */
  motion: Schema.NullOr(Schema.Boolean),
});

export interface CameraState extends Schema.Schema.Type<typeof CameraState> {}

export const Details = Schema.Struct({
  /** The source's own clock, where it keeps one. */
  clock: Schema.NullOr(LocalTime),
  facts: Schema.Array(Fact),
  storage: Schema.Array(Storage),
  cameras: Schema.Array(CameraState),
});

export interface Details extends Schema.Schema.Type<typeof Details> {}

/**
 * Something about a source that needs you. An alert is pushed and counted;
 * a passive one is only listed.
 */
export const Attention = Schema.Struct({
  source: SourceId,
  level: Schema.Literals(["alert", "passive"]),
  kind: Schema.Literals(["connection", "storage", "signal"]),
  message: Schema.String,
});

export interface Attention extends Schema.Schema.Type<typeof Attention> {}
