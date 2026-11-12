/**
 * Recorded video as a download sends it: after the reply to the request, a
 * run of packs (PackHead in the SDK) that each carry a piece of a frame, and
 * a pack that marks the end of the file. Each frame opens with a 40-byte
 * header the SDK doesn't describe, worked out by reverse engineering and
 * checked against what the recorder sends.
 *
 * @module
 */
import type { RecordedFrame } from "@timmo001/kestrel-core";
import { concat, readHeader, reader } from "./Codec.ts";
import { ackReasons } from "./Messages.ts";

export type { RecordedFrame };

/** What a chunk completed: frames, whether the file has ended, and why reading stopped if it can't go on. */
export interface DecodedRecording {
  readonly frames: Array<RecordedFrame>;
  readonly ended: boolean;
  readonly problem?: string;
  /** The ack, when the recorder turned the request down. */
  readonly refused?: number;
}

const packHeaderSize = 12;

/**
 * PackHead.Type: a piece of a frame, no recording after this point (the end
 * of a playback), and the end of a downloaded file.
 */
const PackType = { frame: 0, noData: 2, fileEnd: 3 } as const;

const frameHeaderSize = 40;

/** "RSFm" as a little-endian u32. */
const frameMagic = 0x6d465352;

/** The kind byte of video frames: "I" for key frames and "P" for the rest. */
const keyFrame = 0x49;

const deltaFrame = 0x50;

/**
 * A frame's header: the "RSFm" magic, the kind at 4, the codec data's
 * length at 12, the recorder's clock at 16, the size at 32 and 34 and the
 * frame rate at 36. The data follows, padded to a multiple of 8.
 */
export const parseFrame = (bytes: Uint8Array): RecordedFrame | undefined => {
  const body = reader(bytes);
  const kind = body.u8(4);

  if (bytes.length < frameHeaderSize || body.u32(0) !== frameMagic) {
    return undefined;
  }

  if (kind !== keyFrame && kind !== deltaFrame) return undefined;

  const end = Math.min(frameHeaderSize + body.u32(12), bytes.length);

  return {
    key: kind === keyFrame,
    time: Number(body.u64(16)),
    width: body.u16(32),
    height: body.u16(34),
    fps: body.u8(36),
    data: bytes.subarray(frameHeaderSize, end),
  };
};

/**
 * Reads a download's or a playback's connection: feed it each chunk as it
 * arrives. It reads the reply first, then joins each frame's packs and
 * parses it, and reports the end of the file or of the recordings.
 */
export const recordingDecoder = () => {
  let pending = new Uint8Array(0);
  let replied = false;
  let ended = false;

  let frame:
    { number: number; packs: number; parts: Array<Uint8Array> } | undefined;

  return (chunk: Uint8Array): DecodedRecording => {
    pending = concat(pending, chunk);
    const frames: Array<RecordedFrame> = [];

    if (!replied) {
      const reply = readHeader(pending);

      if (reply === undefined) return { frames, ended };

      if ("problem" in reply) {
        return { frames, ended, problem: reply.problem };
      }

      if (reply.ack !== 0) {
        const reason = ackReasons.get(reply.ack) ?? `ack ${reply.ack}`;

        return {
          frames,
          ended,
          problem: `The recorder turned the request down: ${reason}`,
          refused: reply.ack,
        };
      }

      if (pending.length < reply.length + reply.bodySize) {
        return { frames, ended };
      }

      replied = true;
      pending = pending.subarray(reply.length + reply.bodySize);
    }

    while (!ended && pending.length >= packHeaderSize) {
      const head = reader(pending);
      // The top six bits of the first byte count extra 4-byte header words.
      const start = packHeaderSize + (head.u8(0) >> 2) * 4;
      const size = head.u16(10);

      if (pending.length < start + size) break;

      const type = head.u8(1);
      const packs = head.u16(2);
      const number = head.u32(4);
      const data = pending.subarray(start, start + size);

      pending = pending.subarray(start + size);

      if (type === PackType.fileEnd || type === PackType.noData) {
        ended = true;
      } else if (type === PackType.frame) {
        if (frame?.number !== number) frame = { number, packs, parts: [] };

        frame.parts.push(data);

        if (frame.parts.length >= frame.packs) {
          const parsed = parseFrame(concat(...frame.parts));

          if (parsed !== undefined) frames.push(parsed);

          frame = undefined;
        }
      }
    }

    return { frames, ended };
  };
};
