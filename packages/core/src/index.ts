/**
 * What every source shares: how sources and cameras are named, what they
 * report (cameras, recordings, events and details), their errors, and the
 * `Source` interface each kind implements and the server serves.
 *
 * @module
 */
export * from "./Cameras.ts";

export * from "./Details.ts";

export * from "./Errors.ts";

export * from "./Events.ts";

export * from "./Ids.ts";

export * from "./Recordings.ts";

export * from "./Sources.ts";

export * from "./Times.ts";

export type {
  CameraInfo,
  LiveFeed,
  RecordedFrame,
  Source,
  SourceEvents,
  SourceRecordings,
} from "./Source.ts";
