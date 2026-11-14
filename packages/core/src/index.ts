/**
 * What every source shares: how sources and cameras are named and set up,
 * what they report (cameras, recordings, events and details), their errors,
 * and the `Source` interface each kind implements and the server serves,
 * and the version the server and its clients share.
 *
 * @module
 */
export * from "./Cameras.ts";

export * from "./Controls.ts";

export * from "./Details.ts";

export * from "./Errors.ts";

export * from "./Events.ts";

export * from "./Ids.ts";

export * from "./Recordings.ts";

export * from "./Settings.ts";

export * from "./Sources.ts";

export * from "./Times.ts";

export * from "./Uploads.ts";

export * from "./Version.ts";

export type {
  CameraInfo,
  LiveFeed,
  LiveView,
  Pace,
  RecordedFrame,
  Source,
  SourceEvents,
  SourcePicture,
  SourcePtz,
  SourceRecordings,
  SourceStills,
  SourceUploads,
  StillPicture,
  UploadedClip,
  UploadTarget,
} from "./Source.ts";
