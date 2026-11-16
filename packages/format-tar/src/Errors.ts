/**
 * What can go wrong reading or writing a tar archive.
 *
 * @module
 */
import { Schema } from "effect";

/** An archive couldn't be written, or what was read isn't a whole tar archive. */
export class TarError extends Schema.TaggedError<TarError>()("TarError", {
  message: Schema.String,
}) {}
