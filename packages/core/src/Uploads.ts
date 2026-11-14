/**
 * Cameras sending their clips to Kestrel, such as by FTP: whether a
 * source's cameras do now, and how turning it on or off went.
 *
 * @module
 */
import { Schema } from "effect";

/** Whether a source's cameras send their clips to Kestrel now, and when the last came. */
export const UploadState = Schema.Struct({
  on: Schema.Boolean,
  /** When the last clip came, as an ISO time. */
  last: Schema.NullOr(Schema.String),
});

export interface UploadState extends Schema.Schema.Type<typeof UploadState> {}

/** Turns sending clips to Kestrel on or off. */
export const UploadChange = Schema.Struct({ on: Schema.Boolean });

export interface UploadChange extends Schema.Schema.Type<typeof UploadChange> {}

/** How turning it on or off went. */
export const UploadCheck = Schema.Struct({
  on: Schema.Boolean,
  /** The camera's own test of the connection: whether it passed, or `null` for a camera without one. */
  tested: Schema.NullOr(Schema.Boolean),
  /** What to tell you, such as what the test said. */
  message: Schema.String,
});

export interface UploadCheck extends Schema.Schema.Type<typeof UploadCheck> {}
