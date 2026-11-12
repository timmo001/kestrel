/**
 * Kestrel's own recorder: records cameras' streams to disk with ffmpeg, in
 * short files by day, and clears out old days. It knows nothing of any kind
 * of source; the server hands it each camera's stream.
 *
 * @module
 */
export * from "./Recorder.ts";
