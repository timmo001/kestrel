/**
 * Recorded video as MP4 files: frames written as fragmented MP4, which a
 * browser plays as it arrives, and MP4 files read back as frames. It knows
 * nothing of where the video comes from.
 *
 * @module
 */
export * from "./Errors.ts";

export * from "./Read.ts";

export * from "./Write.ts";
