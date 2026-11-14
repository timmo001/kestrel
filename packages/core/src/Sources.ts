/**
 * A source as the API lists it: what it is and whether the server is
 * connected to it.
 *
 * @module
 */
import { Schema } from "effect";
import { SourceId } from "./Ids.ts";

/** Whether the server is connected to a source, since when, and why not. */
export const Connection = Schema.Struct({
  connected: Schema.Boolean,
  since: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

export interface Connection extends Schema.Schema.Type<typeof Connection> {}

export const SourceInfo = Schema.Struct({
  id: SourceId,
  /** Which kind of source, such as `raysharp`. */
  kind: Schema.String,
  name: Schema.String,
  connection: Connection,
  /** Whether it has details to show, as a recorder does. */
  details: Schema.Boolean,
  /** Whether its cameras can send their clips to Kestrel. */
  uploads: Schema.Boolean,
});

export interface SourceInfo extends Schema.Schema.Type<typeof SourceInfo> {}
