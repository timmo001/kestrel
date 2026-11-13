/**
 * Reading MP4 files back as recorded frames, the way a source sends them:
 * H.264 or H.265 in Annex B form, each key frame starting with its
 * parameter sets, timed from when the file starts. Files still being written
 * read up to where they've got.
 *
 * @module
 */
import type { RecordedFrame } from "@timmo001/kestrel-core";
import { Effect, Stream } from "effect";
import {
  EncodedPacketSink,
  FilePathSource,
  Input,
  MP4,
  type EncodedPacket,
} from "mediabunny";
import { Mp4Error } from "./Errors.ts";

/** A file's length and picture size. */
export interface Mp4Info {
  /** How long it runs, in seconds. */
  readonly duration: number;
  readonly width: number;
  readonly height: number;
}

/** The parameter sets a file keeps apart from its frames, and how long each frame's NAL lengths are. */
interface ParameterSets {
  readonly lengthSize: number;
  readonly sets: ReadonlyArray<Uint8Array>;
}

const startCode = [0, 0, 0, 1];

const bytesOf = (description: AllowSharedBufferSource) =>
  ArrayBuffer.isView(description)
    ? new Uint8Array(
        description.buffer,
        description.byteOffset,
        description.byteLength,
      )
    : new Uint8Array(description);

/** The SPS and PPS in an `avcC` box's contents. */
const avcSets = (bytes: Uint8Array): ParameterSets => {
  const sets: Array<Uint8Array> = [];
  let at = 6;

  const take = (count: number) => {
    for (let index = 0; index < count && at + 2 <= bytes.length; index++) {
      const length = ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

      sets.push(bytes.subarray(at + 2, at + 2 + length));
      at += 2 + length;
    }
  };

  take((bytes[5] ?? 0) & 0x1f);

  const ppsCount = bytes[at] ?? 0;

  at += 1;
  take(ppsCount);

  return { lengthSize: ((bytes[4] ?? 3) & 3) + 1, sets };
};

/** The VPS, SPS and PPS in an `hvcC` box's contents: arrays of NAL units after a 23 byte header. */
const hevcSets = (bytes: Uint8Array): ParameterSets => {
  const sets: Array<Uint8Array> = [];
  const arrays = bytes[22] ?? 0;
  let at = 23;

  for (let array = 0; array < arrays && at + 3 <= bytes.length; array++) {
    const count = ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);

    at += 3;

    for (let index = 0; index < count && at + 2 <= bytes.length; index++) {
      const length = ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

      sets.push(bytes.subarray(at + 2, at + 2 + length));
      at += 2 + length;
    }
  }

  return { lengthSize: ((bytes[21] ?? 3) & 3) + 1, sets };
};

/** Whether a NAL unit is a sequence parameter set, which every key frame needs before it. */
const isSps = (unit: Uint8Array, hevc: boolean) =>
  hevc ? (((unit[0] ?? 0) >> 1) & 0x3f) === 33 : ((unit[0] ?? 0) & 0x1f) === 7;

/** A frame's NAL units with start codes rather than lengths, and a key frame's parameter sets put in front when it lacks them. */
const annexB = (
  data: Uint8Array,
  config: ParameterSets,
  hevc: boolean,
  key: boolean,
) => {
  const units: Array<Uint8Array> = [];
  let at = 0;

  while (at + config.lengthSize <= data.length) {
    let length = 0;

    for (let index = 0; index < config.lengthSize; index++) {
      length = length * 256 + (data[at + index] ?? 0);
    }

    at += config.lengthSize;
    units.push(data.subarray(at, at + length));
    at += length;
  }

  const hasSps = units.some((unit) => isSps(unit, hevc));
  const all = key && !hasSps ? [...config.sets, ...units] : units;

  const out = new Uint8Array(
    all.reduce((size, unit) => size + startCode.length + unit.length, 0),
  );

  let position = 0;

  for (const unit of all) {
    out.set(startCode, position);
    out.set(unit, position + startCode.length);
    position += startCode.length + unit.length;
  }

  return out;
};

/** A promise's result, or its failure as an `Mp4Error`. */
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new Mp4Error({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/** A file's H.264 or H.265 track, closed with the scope. */
const opened = (path: string) =>
  Effect.acquireRelease(
    attempt(async () => {
      const input = new Input({
        source: new FilePathSource(path),
        formats: [MP4],
      });

      const track = await input.getPrimaryVideoTrack().catch((error) => {
        input.dispose();
        throw error;
      });

      if (track?.codec !== "avc" && track?.codec !== "hevc") {
        input.dispose();
        throw new Error(`${path} has no H.264 or H.265 video`);
      }

      return { input, track };
    }),
    ({ input }) => Effect.sync(() => input.dispose()),
  );

/** How long a file runs and its picture size. */
export const info = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { track } = yield* opened(path);
      const sink = new EncodedPacketSink(track);

      const last = yield* attempt(() =>
        sink.getPacket(Infinity, { metadataOnly: true }),
      );

      return {
        duration: last === null ? 0 : last.timestamp + last.duration,
        width: track.codedWidth,
        height: track.codedHeight,
      } satisfies Mp4Info;
    }),
  );

export interface ReadOptions {
  readonly path: string;
  /** When the file starts, in microseconds since 1970, on the clock the frames should carry. */
  readonly start: number;
  /** Seconds into the file to start from; it starts at the key frame at or before it. */
  readonly from: number;
  /** Seconds into the file to stop at. */
  readonly to: number;
  /** Key frames only, one per this many seconds. */
  readonly every?: number | undefined;
}

/** A file's frames between two points, or with `every`, key frames only. */
export const frames = (
  options: ReadOptions,
): Stream.Stream<RecordedFrame, Mp4Error> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { track } = yield* opened(options.path);
      const config = yield* attempt(() => track.getDecoderConfig());
      const hevc = track.codec === "hevc";
      const description = config?.description;

      const sets: ParameterSets =
        description === undefined
          ? { lengthSize: 4, sets: [] }
          : (hevc ? hevcSets : avcSets)(bytesOf(description));

      const stats = yield* attempt(() => track.computePacketStats(50));
      const sink = new EncodedPacketSink(track);
      const verified = { verifyKeyPackets: true };

      const frameOf = (packet: EncodedPacket): RecordedFrame => ({
        key: packet.type === "key",
        codec: hevc ? "h265" : "h264",
        time: options.start + Math.round(packet.timestamp * 1e6),
        width: track.codedWidth,
        height: track.codedHeight,
        fps: stats.averagePacketRate,
        data: annexB(packet.data, sets, hevc, packet.type === "key"),
      });

      const first = yield* attempt(async () => {
        const at = await sink.getKeyPacket(Math.max(options.from, 0), verified);

        return at ?? (await sink.getFirstKeyPacket(verified));
      });

      if (first === null) return Stream.empty;

      const every = options.every;

      if (every === undefined) {
        return Stream.fromAsyncIterable(
          sink.packets(first),
          (cause) =>
            new Mp4Error({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        ).pipe(
          Stream.takeWhile((packet) => packet.timestamp <= options.to),
          Stream.map(frameOf),
        );
      }

      /** The key frame `every` seconds on, or the next one when they're further apart. */
      const after = async (packet: EncodedPacket) => {
        const ahead = await sink.getKeyPacket(
          packet.timestamp + every,
          verified,
        );

        return ahead !== null && ahead.timestamp > packet.timestamp
          ? ahead
          : await sink.getNextKeyPacket(packet, verified);
      };

      return Stream.unfold<
        EncodedPacket | null,
        RecordedFrame,
        Mp4Error,
        never
      >(first, (packet) =>
        packet === null || packet.timestamp > options.to
          ? Effect.succeed(undefined)
          : attempt(() => after(packet)).pipe(
              Effect.map((next) => [frameOf(packet), next] as const),
            ),
      );
    }),
  );
