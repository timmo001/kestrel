/**
 * The media stream a Reolink device sends over its own protocol, as in a
 * replayed recording: a stream header, then video frames in Annex B form
 * and audio frames, each with a small header and padded to 8 bytes.
 *
 * @module
 */

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

const streamHeaders = new Set(["1001", "1002"]);
const keyFrame = "00dc";
const otherFrame = "01dc";
const audioFrames = new Set(["05wb", "01wb"]);
const tags = ["1001", "1002", keyFrame, otherFrame, "05wb", "01wb"];

const padded = (length: number) => length + ((8 - (length % 8)) % 8);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Reads a whole media stream; anything it doesn't know is skipped to the next frame. */
export const decode = (bytes: Uint8Array): Media => {
  const fields = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // One character per byte, so positions match
  const text = new TextDecoder("latin1").decode(bytes);
  const frames: Array<MediaFrame> = [];
  let codec = "";
  let at = 0;

  const tagAt = (offset: number) => text.slice(offset, offset + 4);

  while (at + 8 <= bytes.length) {
    const tag = tagAt(at);

    if (streamHeaders.has(tag) && at + 32 <= bytes.length) {
      at += 32;
    } else if (
      (tag === keyFrame || tag === otherFrame) &&
      at + 24 <= bytes.length
    ) {
      const length = fields.getUint32(at + 8, true);
      const extra = fields.getUint32(at + 12, true);
      const start = at + 24 + extra;
      const data = bytes.subarray(start, start + length);

      // It sometimes sends a frame twice
      const previous = frames.at(-1);

      if (previous === undefined || !sameBytes(previous.data, data)) {
        codec = tagAt(at + 4);
        frames.push({
          key: tag === keyFrame,
          microseconds: fields.getUint32(at + 16, true),
          data,
        });
      }

      at = start + padded(length);
    } else if (audioFrames.has(tag)) {
      at += 8 + padded(fields.getUint16(at + 4, true));
    } else {
      const next = tags
        .map((each) => text.indexOf(each, at + 1))
        .reduce(
          (nearest, found) =>
            found === -1 ? nearest : Math.min(nearest, found),
          bytes.length,
        );

      at = next;
    }
  }

  return { codec, frames };
};
