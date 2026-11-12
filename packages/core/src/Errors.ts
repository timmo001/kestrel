/**
 * The errors a source and the API return, each with its HTTP status.
 *
 * @module
 */
import { Schema } from "effect";

/** The server has no working connection to that source right now. */
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "SourceUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Nothing was recorded on that camera in that range. */
export class NoRecordings extends Schema.TaggedError<NoRecordings>()(
  "NoRecordings",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** No source has that id. */
export class UnknownSource extends Schema.TaggedError<UnknownSource>()(
  "UnknownSource",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** No source has a camera with that id. */
export class UnknownCamera extends Schema.TaggedError<UnknownCamera>()(
  "UnknownCamera",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Settings that can't be used, such as two sources with one id or a missing address. */
export class InvalidSettings extends Schema.TaggedError<InvalidSettings>()(
  "InvalidSettings",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The source or camera can't do that, such as a stream with no recordings. */
export class NotSupported extends Schema.TaggedError<NotSupported>()(
  "NotSupported",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}
