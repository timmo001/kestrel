/**
 * Kestrel's own recordings: records cameras' streams to disk with ffmpeg, in
 * short files by day, clears out old days, and reads the folder back. It
 * knows nothing of any kind of source; the server hands it each camera's
 * stream and key.
 *
 * @module
 */
export * from "./Layout.ts";

export * from "./Recorder.ts";

export * as Library from "./Library.ts";
