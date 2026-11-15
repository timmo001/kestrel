/**
 * Repairing H.264 recordings where a camera wove its sub stream's frames
 * into the main stream's, as Reolink cameras' RTSP sometimes does: two
 * pictures in one track, under the same parameter set ids, which play as
 * a picture that keeps breaking up. They come apart without decoding: the
 * main picture's key frames are several times the size of the other's, and
 * each other frame carries on one picture's frame counter. The repair keeps
 * the main picture and drops the rest, leaving out any frame it can't place
 * and what follows it up to the main picture's next key frame.
 *
 * @module
 */

/** How many times larger one picture's key frames must be than the other's to tell them apart by size. */
export const keyGap = 3;

/** Profiles whose SPS carries chroma format, bit depths and scaling lists. */
const highProfiles = new Set([
  44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244,
]);

/** What a repair needs to know of a file with two pictures in it. */
export interface Mixed {
  /** Key frames this many bytes or more are the main picture's. */
  readonly split: number;
  /** The main picture's SPS and PPS, put in front of each of its key frames. */
  readonly sets: ReadonlyArray<Uint8Array>;
  readonly width: number;
  readonly height: number;
  /** How many bits a slice header's frame number takes. */
  readonly frameBits: number;
  /** The PPS id every slice of either picture names. */
  readonly pps: number;
}

type Picture = "main" | "other";

const typeOf = (unit: Uint8Array) => (unit[0] ?? 0) & 0x1f;

const isSlice = (unit: Uint8Array) => typeOf(unit) === 1 || typeOf(unit) === 5;

const isParameterSet = (unit: Uint8Array) =>
  typeOf(unit) === 7 || typeOf(unit) === 8;

/** Up to `limit` bytes of a NAL unit after its header, with emulation prevention bytes taken out. */
const payloadOf = (unit: Uint8Array, limit: number) => {
  const out: Array<number> = [];
  let zeros = 0;

  for (let at = 1; at < unit.length && out.length < limit; at++) {
    const byte = unit[at] ?? 0;

    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }

    zeros = byte === 0 ? zeros + 1 : 0;
    out.push(byte);
  }

  return out;
};

/** Reads bits and Exp-Golomb numbers in order; `past` says whether it ran off the end. */
const bitsOf = (bytes: ReadonlyArray<number>) => {
  let at = 0;

  const bit = () => {
    const value = ((bytes[at >> 3] ?? 0) >> (7 - (at & 7))) & 1;

    at++;

    return value;
  };

  const bits = (count: number) => {
    let value = 0;

    for (let index = 0; index < count; index++) value = value * 2 + bit();

    return value;
  };

  const exp = () => {
    let zeros = 0;

    while (bit() === 0) {
      zeros++;

      if (zeros > 31) return Number.MAX_SAFE_INTEGER;
    }

    return 2 ** zeros - 1 + bits(zeros);
  };

  return { bits, exp, past: () => at > bytes.length * 8 };
};

/** The picture size and frame number length an SPS gives, or `undefined` for one this can't read. */
const spsOf = (unit: Uint8Array) => {
  const read = bitsOf(payloadOf(unit, 96));
  const profile = read.bits(8);

  read.bits(16);
  read.exp();

  let chroma = 1;

  if (highProfiles.has(profile)) {
    chroma = read.exp();

    // Separate colour planes put more in the slice header
    if (chroma === 3 && read.bits(1) === 1) return undefined;

    read.exp();
    read.exp();
    read.bits(1);

    // Scaling lists come before what's needed and are rare in cameras
    if (read.bits(1) === 1) return undefined;
  }

  const frameBits = read.exp() + 4;
  const order = read.exp();

  if (order === 0) {
    read.exp();
  } else if (order === 1) {
    read.bits(1);
    read.exp();
    read.exp();

    const cycle = read.exp();

    if (cycle > 255) return undefined;

    for (let index = 0; index < cycle; index++) read.exp();
  }

  read.exp();
  read.bits(1);

  const widthMbs = read.exp() + 1;
  const heightUnits = read.exp() + 1;
  const framesOnly = read.bits(1);

  if (framesOnly === 0) read.bits(1);

  read.bits(1);

  const crop =
    read.bits(1) === 1
      ? [read.exp(), read.exp(), read.exp(), read.exp()]
      : [0, 0, 0, 0];

  if (read.past() || frameBits > 16) return undefined;

  const cropX = chroma === 1 || chroma === 2 ? 2 : 1;
  const cropY = (chroma === 1 ? 2 : 1) * (2 - framesOnly);
  const [left = 0, right = 0, top = 0, bottom = 0] = crop;

  return {
    frameBits,
    width: widthMbs * 16 - cropX * (left + right),
    height: heightUnits * 16 * (2 - framesOnly) - cropY * (top + bottom),
  };
};

/** The fields a slice header starts with. */
const sliceOf = (unit: Uint8Array, frameBits: number) => {
  const read = bitsOf(payloadOf(unit, 16));

  return {
    first: read.exp(),
    type: read.exp(),
    pps: read.exp(),
    frame: read.bits(frameBits),
  };
};

/**
 * Where a file's key frames come in two sizes, at least `keyGap` times
 * apart, the size between them; `undefined` when they don't. The two are
 * found by Otsu's method on the sizes' logarithms, so a few odd key frames,
 * such as one the camera cut short, don't pass for a picture of their own.
 */
export const splitOf = (sizes: ReadonlyArray<number>) => {
  const logs = sizes
    .flatMap((size) => (size > 0 ? [Math.log(size)] : []))
    .toSorted((a, b) => a - b);

  const total = logs.reduce((sum, each) => sum + each, 0);
  let below = 0;
  let best = 0;
  let split: number | undefined;

  for (let index = 1; index < logs.length; index++) {
    const low = logs[index - 1] ?? 0;
    const high = logs[index] ?? 0;

    below += low;

    const apart = (total - below) / (logs.length - index) - below / index;

    const spread = index * (logs.length - index) * apart ** 2;

    if (spread > best) {
      best = spread;
      split =
        high - low >= Math.log(keyGap) ? Math.exp((low + high) / 2) : undefined;
    }
  }

  return split;
};

/**
 * The repair for a file whose key frames are `split` bytes apart in size,
 * from the NAL units of some of each: `undefined` unless their SPSs give two
 * picture sizes, as a file of one picture whose key frames just vary has
 * one. The larger is the main picture; which frames each SPS came with
 * says nothing, as the camera sends them with either.
 */
export const mixedOf = (
  units: ReadonlyArray<Uint8Array>,
  split: number,
): Mixed | undefined => {
  const pictures = units.flatMap((unit) => {
    const read = typeOf(unit) === 7 ? spsOf(unit) : undefined;

    return read === undefined ? [] : [{ unit, ...read }];
  });

  const sorted = pictures.toSorted(
    (a, b) => a.width * a.height - b.width * b.height,
  );

  const other = sorted[0];
  const main = sorted.at(-1);
  const pps = units.find((unit) => typeOf(unit) === 8);

  if (
    other === undefined ||
    main === undefined ||
    pps === undefined ||
    main.width * main.height === other.width * other.height ||
    // Slices are read the same way for both, as nothing says which they are
    main.frameBits !== other.frameBits
  ) {
    return undefined;
  }

  return {
    split,
    sets: [main.unit, pps],
    width: main.width,
    height: main.height,
    frameBits: main.frameBits,
    pps: bitsOf(payloadOf(pps, 4)).exp(),
  };
};

/** One of the main picture's frames, kept: a key frame starts with its parameter sets. */
export interface Kept {
  readonly key: boolean;
  readonly units: ReadonlyArray<Uint8Array>;
}

/**
 * Sorts frames, given in order as their NAL units and size in bytes, into
 * the main picture's, which it hands back, and the rest, which it drops.
 */
export const repairer = (mixed: Mixed) => {
  const wrap = 2 ** mixed.frameBits;
  /** The frame number each picture's next frame carries. */
  const next = new Map<Picture, number>();
  /** Each picture's usual size of frame between key frames. */
  const usual = new Map<Picture, number>();
  let waiting = true;

  const carriesOn = (frame: number, bytes: number): Picture | undefined => {
    const fits = (["main", "other"] as const).filter(
      (picture) => next.get(picture) === frame,
    );

    if (fits.length === 1) return fits[0];

    // Carrying on neither while one's counter isn't known yet, as at the
    // start of a file, it's that one's
    const unknown = (["main", "other"] as const).filter(
      (picture) => !next.has(picture),
    );

    if (fits.length === 0 && unknown.length === 1) return unknown[0];

    const main = usual.get("main");
    const other = usual.get("other");

    // Both carry on here: the nearer in size, once both sizes are known
    if (fits.length === 2 && main !== undefined && other !== undefined) {
      return Math.abs(Math.log(bytes / main)) <=
        Math.abs(Math.log(bytes / other))
        ? "main"
        : "other";
    }

    return undefined;
  };

  return (
    units: ReadonlyArray<Uint8Array>,
    bytes: number,
  ): Kept | undefined => {
    const unit = units.find(isSlice);

    if (unit === undefined) return undefined;

    const slice = sliceOf(unit, mixed.frameBits);
    const intra = slice.type % 5 === 2;

    // What can't be a whole frame's start of either picture, as where the
    // camera cut one off partway
    const whole =
      slice.first === 0 &&
      slice.type <= 9 &&
      slice.pps === mixed.pps &&
      (typeOf(unit) !== 5 || intra);

    const picture = !whole
      ? undefined
      : intra
        ? bytes >= mixed.split
          ? "main"
          : "other"
        : carriesOn(slice.frame, bytes);

    if (picture === undefined) {
      waiting = true;

      return undefined;
    }

    next.set(picture, (slice.frame + 1) % wrap);

    if (!intra) {
      const before = usual.get(picture);

      usual.set(
        picture,
        before === undefined ? bytes : before * 0.8 + bytes * 0.2,
      );
    }

    if (picture === "other" || (waiting && !intra)) return undefined;

    waiting = false;

    // Parameter sets come with either picture's frames, so only the main
    // picture's own go in, and in front of every key frame
    const body = units.filter((each) => !isParameterSet(each));

    return { key: intra, units: intra ? [...mixed.sets, ...body] : body };
  };
};

/** A key frame of the main picture, standing alone, as for key frames only. */
export const keyFrameOf = (
  mixed: Mixed,
  units: ReadonlyArray<Uint8Array>,
): ReadonlyArray<Uint8Array> => [
  ...mixed.sets,
  ...units.filter((each) => !isParameterSet(each)),
];
