/**
 * What every source shares: the shapes they report, their errors, and the
 * `Recorder` service a source provides and the server reads.
 *
 * @module
 */
export * from "./Domain.ts";

export { Recorder, type LiveFeed, type RecordedFrame } from "./Recorder.ts";
