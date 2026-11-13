/**
 * The media stream a Reolink device sends over its own protocol, as in a
 * replayed recording: a stream header, then video frames in Annex B form
 * and audio frames, each with a small header and padded to 8 bytes. It's
 * read as it comes, so a whole file never has to be held at once.
 *
 * @module
 */
import { concat } from "./Codec.ts";

/** One video frame, as recorded. */
export interface MediaFrame {
  readonly key: boolean;
  /** The device's microsecond counter, which wraps every 71 minutes. */
  readonly microseconds: number;
  /** The frame in Annex B form, with start codes. */
  readonly data: Uint8Array;
}

/** What a media stream holds: its video codec and its video frames. */
export interface Media {
  /** `H264` or `H265`, or `""` when it held no video. */
  readonly codec: string;
  readonly frames: ReadonlyArray<MediaFrame>;
}

/** Reads a media stream a piece at a time. */
export interface MediaDecoder {
  /** Reads the next piece, and returns the frames it completes. */
  readonly push: (piece: Uint8Array) => ReadonlyArray<MediaFrame>;
  /** Once the stream has ended, the frames left, the last cut short where it was. */
  readonly end: () => ReadonlyArray<MediaFrame>;
  /** `H264` or `H265`, or `""` before any video. */
  readonly codec: () => string;
}

const streamHeaders = new Set(["1001", "1002"]);
const keyFrame = "00dc";
const otherFrame = "01dc";
const audioFrames = new Set(["05wb", "01wb"]);
const tags = new Set(["1001", "1002", keyFrame, otherFrame, "05wb", "01wb"]);
const empty = new Uint8Array(0);

const padded = (length: number) => length + ((8 - (length % 8)) % 8);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const tagAt = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0,
  );

/** Where the next tag it knows starts, from `from`, or -1. */
const nextTag = (bytes: Uint8Array, from: number) => {
  for (let at = from; at + 4 <= bytes.length; at++) {
    if (tags.has(tagAt(bytes, at))) return at;
  }

  return -1;
};

/** Reads a media stream as it comes; anything it doesn't know is skipped to the next frame. */
export const decoder = (): MediaDecoder => {
  let pending: Uint8Array = empty;
  let codec = "";
  let previous: Uint8Array | undefined;

  const read = (ending: boolean) => {
    const bytes = pending;

    const fields = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );

    const frames: Array<MediaFrame> = [];
    let at = 0;

    while (at + 8 <= bytes.length) {
      const tag = tagAt(bytes, at);

      if (streamHeaders.has(tag)) {
        if (at + 32 > bytes.length) {
          if (ending) at = bytes.length;
          break;
        }

        at += 32;
      } else if (tag === keyFrame || tag === otherFrame) {
        if (at + 24 > bytes.length) {
          if (ending) at = bytes.length;
          break;
        }

        const length = fields.getUint32(at + 8, true);
        const extra = fields.getUint32(at + 12, true);
        const start = at + 24 + extra;
        const end = start + padded(length);

        if (end > bytes.length && !ending) break;

        const data = bytes.subarray(start, start + length);

        // It sometimes sends a frame twice
        if (previous === undefined || !sameBytes(previous, data)) {
          codec = tagAt(bytes, at + 4);
          previous = data;
          frames.push({
            key: tag === keyFrame,
            microseconds: fields.getUint32(at + 16, true),
            data,
          });
        }

        at = Math.min(end, bytes.length);
      } else if (audioFrames.has(tag)) {
        const end = at + 8 + padded(fields.getUint16(at + 4, true));

        if (end > bytes.length && !ending) break;

        at = Math.min(end, bytes.length);
      } else {
        const found = nextTag(bytes, at + 1);

        if (found === -1) {
          // A tag may start in the last few bytes and end in the next piece
          at = ending ? bytes.length : Math.max(at + 1, bytes.length - 3);
          break;
        }

        at = found;
      }
    }

    pending = ending || at >= bytes.length ? empty : bytes.subarray(at);

    return frames;
  };

  return {
    push: (piece) => {
      pending = pending.length === 0 ? piece : concat(pending, piece);

      return read(false);
    },
    end: () => read(true),
    codec: () => codec,
  };
};

/** Reads a whole media stream; anything it doesn't know is skipped to the next frame. */
export const decode = (bytes: Uint8Array): Media => {
  const reading = decoder();
  const frames = [...reading.push(bytes), ...reading.end()];

  return { codec: reading.codec(), frames };
};
