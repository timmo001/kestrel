/**
 * What can go wrong reading or writing MP4.
 *
 * @module
 */
import { Schema } from "effect";

/** Video couldn't be read from or written as MP4. */
export class Mp4Error extends Schema.TaggedError<Mp4Error>()("Mp4Error", {
  message: Schema.String,
}) {}
