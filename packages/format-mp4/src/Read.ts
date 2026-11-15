/**
 * Reading MP4 files back as recorded frames, the way a source sends them:
 * H.264 or H.265 in Annex B form, each key frame starting with its
 * parameter sets, timed from when the file starts. Files still being written
 * read up to where they've got. Files a camera wove two pictures into come
 * out as the main picture alone.
 *
 * @module
 */
import type { RecordedFrame } from "@timmo001/kestrel-core";
import { Effect, FileSystem, Predicate, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import {
  CustomSource,
  EncodedPacketSink,
  FilePathSource,
  Input,
  MP4,
  type EncodedPacket,
  type InputVideoTrack,
  type Source,
} from "mediabunny";
import { Mp4Error } from "./Errors.ts";
import * as Mixed from "./Mixed.ts";

/** A file's length and picture size. */
export interface Mp4Info {
  /** How long it runs, in seconds. */
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  /** Whether the camera wove a second, smaller picture into it, which reading leaves out. */
  readonly mixed: boolean;
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

/** A frame's NAL units, each after its length. */
const unitsOf = (data: Uint8Array, lengthSize: number) => {
  const units: Array<Uint8Array> = [];
  let at = 0;

  while (at + lengthSize <= data.length) {
    let length = 0;

    for (let index = 0; index < lengthSize; index++) {
      length = length * 256 + (data[at + index] ?? 0);
    }

    at += lengthSize;
    units.push(data.subarray(at, at + length));
    at += length;
  }

  return units;
};

/** NAL units each after a start code. */
const joined = (units: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(
    units.reduce((size, unit) => size + startCode.length + unit.length, 0),
  );

  let position = 0;

  for (const unit of units) {
    out.set(startCode, position);
    out.set(unit, position + startCode.length);
    position += startCode.length + unit.length;
  }

  return out;
};

/** A frame's NAL units with start codes rather than lengths, and a key frame's parameter sets put in front when it lacks them. */
const annexB = (
  data: Uint8Array,
  config: ParameterSets,
  hevc: boolean,
  key: boolean,
) => {
  const units = unitsOf(data, config.lengthSize);
  const hasSps = units.some((unit) => isSps(unit, hevc));

  return joined(key && !hasSps ? [...config.sets, ...units] : units);
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

/**
 * A file read for its index alone, reading only the bytes asked for. A
 * recording is in fragments of a second or two, and the usual source pads
 * each read of a fragment's header to 192 KB, so reading a 5 minute file's
 * index read some 30 MB of it.
 */
const indexSource = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.open(path);
  const size = Number((yield* file.stat).size);

  /** Fills `buffer` from `start` on, as a read may stop short. */
  const fill = (
    buffer: Uint8Array,
    start: number,
    done: number,
  ): Effect.Effect<Uint8Array, Mp4Error | PlatformError> =>
    done === buffer.length
      ? Effect.succeed(buffer)
      : file
          .read(buffer.subarray(done), { position: BigInt(start + done) })
          .pipe(
            Effect.flatMap((read) =>
              read === 0
                ? Effect.fail(
                    new Mp4Error({
                      message: `${path} ended at byte ${start + done}`,
                    }),
                  )
                : fill(buffer, start, done + read),
            ),
          );

  return new CustomSource({
    getSize: () => size,
    read: (start, end) =>
      Effect.runPromise(fill(new Uint8Array(end - start), start, 0)),
    prefetchProfile: "none",
  });
});

/** An input's H.264 or H.265 track, with the input disposed of with the scope. */
const trackOf = (path: string, source: Source) =>
  Effect.acquireRelease(
    attempt(async () => {
      const input = new Input({ source, formats: [MP4] });

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

/** A file's H.264 or H.265 track, closed with the scope. */
const opened = (path: string) => trackOf(path, new FilePathSource(path));

/** A file's H.264 or H.265 track for reading its index, closed with the scope. */
const openedIndex = (path: string) =>
  indexSource(path).pipe(
    Effect.mapError((error) =>
      Predicate.isTagged(error, "Mp4Error")
        ? error
        : new Mp4Error({ message: error.message }),
    ),
    Effect.flatMap((source) => trackOf(path, source)),
  );

/** The parameter sets a track keeps in its decoder config. */
const setsOf = (track: InputVideoTrack) =>
  attempt(async (): Promise<ParameterSets> => {
    const description = (await track.getDecoderConfig())?.description;

    if (description === undefined) return { lengthSize: 4, sets: [] };

    return (track.codec === "hevc" ? hevcSets : avcSets)(bytesOf(description));
  });

/** How many key frames of each size a check for two pictures reads. */
const sampled = 4;

/**
 * The repair a file needs where the camera wove two pictures into it, with
 * the main picture's key frames from the file's index; `undefined` for a
 * file of one picture, the usual case, which only reads the index.
 */
const mixedIn = (
  track: InputVideoTrack,
  sink: EncodedPacketSink,
  config: ParameterSets,
) =>
  attempt(async () => {
    if (track.codec !== "avc") return undefined;

    const keys: Array<EncodedPacket> = [];
    const indexOnly = { metadataOnly: true };

    for (
      let key = await sink.getFirstKeyPacket(indexOnly);
      key !== null;
      key = await sink.getNextKeyPacket(key, indexOnly)
    ) {
      keys.push(key);
    }

    const split = Mixed.splitOf(keys.map((key) => key.byteLength));

    if (split === undefined) return undefined;

    const main = keys.filter((key) => key.byteLength >= split);
    const other = keys.filter((key) => key.byteLength < split);
    const units = [...config.sets];

    // Spread through the file, as which SPS comes with which frames varies
    for (const group of [main, other]) {
      const count = Math.min(sampled, group.length);

      for (let index = 0; index < count; index++) {
        const pick = group[Math.floor((index * group.length) / count)];

        const packet =
          pick === undefined ? null : await sink.getKeyPacket(pick.timestamp);

        if (packet !== null) {
          units.push(...unitsOf(packet.data, config.lengthSize));
        }
      }
    }

    const mixed = Mixed.mixedOf(units, split);

    return mixed === undefined ? undefined : { ...mixed, keys: main, other };
  });

/** How long a file runs and its picture size. */
export const info = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { track } = yield* openedIndex(path);
      const sink = new EncodedPacketSink(track);

      const last = yield* attempt(() =>
        sink.getPacket(Infinity, { metadataOnly: true }),
      );

      const mixed = yield* mixedIn(track, sink, yield* setsOf(track));

      return {
        duration: last === null ? 0 : last.timestamp + last.duration,
        width: mixed?.width ?? track.codedWidth,
        height: mixed?.height ?? track.codedHeight,
        mixed: mixed !== undefined,
      } satisfies Mp4Info;
    }),
  );

/** Of key frames in order, the last at or before `at`, or the first. */
const keyAt = (keys: ReadonlyArray<EncodedPacket>, at: number) =>
  keys.findLast((key) => key.timestamp <= at) ?? keys[0];

/**
 * Seconds into a file of the key frame at or before `at`, where reading
 * from `at` starts, or of its first key frame; `null` with none.
 */
export const keyFrameAt = (path: string, at: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { track } = yield* openedIndex(path);
      const sink = new EncodedPacketSink(track);
      const verified = { verifyKeyPackets: true };
      const mixed = yield* mixedIn(track, sink, yield* setsOf(track));

      if (mixed !== undefined) {
        return keyAt(mixed.keys, Math.max(at, 0))?.timestamp ?? null;
      }

      const found = yield* attempt(async () => {
        const before = await sink.getKeyPacket(Math.max(at, 0), verified);

        return before ?? (await sink.getFirstKeyPacket(verified));
      });

      return found?.timestamp ?? null;
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
  /**
   * How many real seconds each of the file's own took, where its camera's
   * clock ran slow: frames are timed by it, so they fill the real time.
   * `from`, `to` and `every` stay in the file's own seconds.
   */
  readonly stretch?: number | undefined;
}

/** When a packet was recorded, in microseconds since 1970, spread out by any stretch. */
const timeOf = (options: ReadOptions, packet: EncodedPacket) =>
  options.start + Math.round(packet.timestamp * (options.stretch ?? 1) * 1e6);

/** Of key frames in order, the one `every` seconds on from `index`, or the next when they're further apart. */
const keyAfter = (
  keys: ReadonlyArray<EncodedPacket>,
  index: number,
  every: number,
) => {
  const at = (keys[index]?.timestamp ?? 0) + every;
  const ahead = keys.findLastIndex((key) => key.timestamp <= at);

  return ahead > index ? ahead : index + 1;
};

/** How far before the main picture's key frame a repair starts reading, to learn the other picture's frame counter. */
const primeLimit = 10;

/** The main picture's frames of a file the camera wove two pictures into. */
const repaired = (
  sink: EncodedPacketSink,
  config: ParameterSets,
  mixed: Mixed.Mixed & {
    readonly keys: ReadonlyArray<EncodedPacket>;
    readonly other: ReadonlyArray<EncodedPacket>;
  },
  options: ReadOptions,
  fps: number,
): Stream.Stream<RecordedFrame, Mp4Error> => {
  const frameOf = (
    packet: EncodedPacket,
    key: boolean,
    units: ReadonlyArray<Uint8Array>,
  ): RecordedFrame => ({
    key,
    codec: "h264",
    time: timeOf(options, packet),
    width: mixed.width,
    height: mixed.height,
    fps: fps / (options.stretch ?? 1),
    data: joined(units),
  });

  const start = keyAt(mixed.keys, Math.max(options.from, 0));
  const every = options.every;

  if (start === undefined) return Stream.empty;

  if (every !== undefined) {
    return Stream.unfold(mixed.keys.indexOf(start), (index) => {
      const key = mixed.keys[index];

      return key === undefined || key.timestamp > options.to
        ? Effect.succeed(undefined)
        : attempt(() => sink.getKeyPacket(key.timestamp)).pipe(
            Effect.map((packet) => {
              const units =
                packet === null ? [] : unitsOf(packet.data, config.lengthSize);

              return [
                frameOf(key, true, Mixed.keyFrameOf(mixed, units)),
                keyAfter(mixed.keys, index, every),
              ] as const;
            }),
          );
    });
  }

  // From the other picture's key frame before it, when there's one near, so
  // both pictures' frame counters are known by the main picture's
  const prime = mixed.other.findLast(
    (key) =>
      key.timestamp <= start.timestamp &&
      start.timestamp - key.timestamp < primeLimit,
  );

  const repair = Mixed.repairer(mixed);

  return Stream.fromEffect(
    attempt(() => sink.getKeyPacket((prime ?? start).timestamp)),
  ).pipe(
    Stream.flatMap((first) =>
      first === null
        ? Stream.empty
        : Stream.fromAsyncIterable(
            sink.packets(first),
            (cause) =>
              new Mp4Error({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
    ),
    Stream.takeWhile((packet) => packet.timestamp <= options.to),
    Stream.map((packet) => {
      const kept = repair(
        unitsOf(packet.data, config.lengthSize),
        packet.byteLength,
      );

      return kept === undefined || packet.timestamp < start.timestamp
        ? undefined
        : frameOf(packet, kept.key, kept.units);
    }),
    Stream.filter((frame) => frame !== undefined),
  );
};

/**
 * A file's frames between two points, or with `every`, key frames only.
 * Where the camera wove two pictures into the file, only the main
 * picture's come out.
 */
export const frames = (
  options: ReadOptions,
): Stream.Stream<RecordedFrame, Mp4Error> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { track } = yield* opened(options.path);
      const hevc = track.codec === "hevc";
      const sets = yield* setsOf(track);
      const stats = yield* attempt(() => track.computePacketStats(50));
      const sink = new EncodedPacketSink(track);
      const verified = { verifyKeyPackets: true };
      const mixed = yield* mixedIn(track, sink, sets);

      if (mixed !== undefined) {
        return repaired(sink, sets, mixed, options, stats.averagePacketRate);
      }

      const frameOf = (packet: EncodedPacket): RecordedFrame => ({
        key: packet.type === "key",
        codec: hevc ? "h265" : "h264",
        time: timeOf(options, packet),
        width: track.codedWidth,
        height: track.codedHeight,
        fps: stats.averagePacketRate / (options.stretch ?? 1),
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
