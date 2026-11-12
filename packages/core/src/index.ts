/**
 * What every source shares: the shapes they report, their errors, and the
 * `Source` interface each kind implements and the server serves.
 *
 * @module
 */
export * from "./Domain.ts";

export type {
  CameraInfo,
  LiveFeed,
  RecordedFrame,
  Source,
  SourceDetails,
  SourceEvents,
  SourceRecordings,
} from "./Source.ts";
