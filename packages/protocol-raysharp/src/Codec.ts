/**
 * The wire format of the Raysharp control protocol: a 16-byte header, a body,
 * and the bit permutation that scrambles both in protocol mode 2.
 *
 * @module
 */

/** Largest body accepted from the recorder, so a bad length can't exhaust memory. */
export const maxBodySize = 4 * 1024 * 1024;

const headerSize = 16;

/** One message as it travels over the connection, after unscrambling. */
export interface Frame {
  readonly mode: number;
  readonly ack: number;
  readonly type: number;
  readonly subtype: number;
  readonly sequence: number;
  readonly body: Uint8Array;
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const bitAt = (bytes: Uint8Array, bit: number) =>
  ((bytes[bit >> 3] ?? 0) & (0x80 >> (bit & 7))) !== 0;

/**
 * The protocol's keyless bit permutation: a Josephus count of 3 over the
 * buffer's bits, most significant bit first. `decode` runs it backwards.
 */
export const permute = (input: Uint8Array, decode = false): Uint8Array => {
  const result = new Uint8Array(input.length);
  const bits = input.length * 8;

  if (bits === 0) return result;

  const next = Uint32Array.from(
    { length: bits },
    (_, index) => (index + 1) % bits,
  );

  let previous = bits - 1;

  for (let step = 0; step < 2 % bits; step++) previous = next[previous] ?? 0;

  for (let index = 0, left = bits; index < bits; index++, left--) {
    for (let step = 0; step < 2 % left; step++) previous = next[previous] ?? 0;
    const selected = next[previous] ?? 0;
    const source = decode ? index : selected;
    const destination = decode ? selected : index;

    if (bitAt(input, source)) {
      result[destination >> 3] =
        (result[destination >> 3] ?? 0) | (0x80 >> (destination & 7));
    }

    next[previous] = next[selected] ?? 0;
  }

  return result;
};

/** Joins byte arrays into a new one. */
export const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );

  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
};

/** Encodes one request. Mode 2 scrambles all but the first two header bytes, and the body. */
export const encodeFrame = (options: {
  readonly mode: number;
  readonly type: number;
  readonly subtype: number;
  readonly sequence: number;
  readonly body: Uint8Array;
}): Uint8Array => {
  const header = new Uint8Array(headerSize);
  const fields = view(header);
  header[0] = options.mode;
  fields.setUint16(4, options.type, true);
  fields.setUint16(6, options.subtype, true);
  fields.setUint32(8, options.body.length, true);
  fields.setUint32(12, options.sequence, true);

  return options.mode === 2
    ? concat(
        header.subarray(0, 2),
        permute(header.subarray(2)),
        permute(options.body),
      )
    : concat(header, options.body);
};

/** A frame's header, unscrambled: everything but the body, with the body's size. */
export interface Header extends Omit<Frame, "body"> {
  /** How many bytes the header takes, with its extra words. */
  readonly length: number;
  readonly bodySize: number;
}

/**
 * Reads the header at the start of `bytes`: undefined until all of it has
 * arrived, or why it can't be read.
 */
export const readHeader = (
  bytes: Uint8Array,
): Header | { readonly problem: string } | undefined => {
  if (bytes.length < headerSize) return undefined;

  const first = bytes[0] ?? 0;
  // The top six bits of the first byte count extra 4-byte header words.
  const length = headerSize + (first >> 2) * 4;

  if (bytes.length < length) return undefined;

  const mode = first & 3;

  if (mode !== 0 && mode !== 2) {
    return { problem: `Unsupported protocol mode ${mode}` };
  }

  const fields = view(
    mode === 2
      ? concat(bytes.subarray(0, 2), permute(bytes.subarray(2, length), true))
      : bytes.subarray(0, length),
  );

  return {
    length,
    mode,
    ack: fields.getUint16(2, true),
    type: fields.getUint16(4, true),
    subtype: fields.getUint16(6, true),
    bodySize: fields.getUint32(8, true),
    sequence: fields.getUint32(12, true),
  };
};

/** The frames a chunk completed, and why reading stopped if the bytes made no sense. */
export interface Decoded {
  readonly frames: Array<Frame>;
  readonly problem?: string;
}

/**
 * Splits the bytes the recorder sends into frames. Feed it each chunk as it
 * arrives; it keeps a partial frame until the rest comes in.
 */
export const frameDecoder = () => {
  let pending = new Uint8Array(0);
  let header: Header | undefined;

  return (chunk: Uint8Array): Decoded => {
    pending = concat(pending, chunk);
    const frames: Array<Frame> = [];

    for (;;) {
      if (header === undefined) {
        const read = readHeader(pending);

        if (read === undefined) return { frames };

        if ("problem" in read) return { frames, problem: read.problem };
        header = read;
        pending = pending.subarray(read.length);
      }

      const size = header.bodySize;

      if (size > maxBodySize)
        return { frames, problem: `Reply too large (${size} bytes)` };

      if (pending.length < size) return { frames };
      const body = pending.subarray(0, size);
      frames.push({
        mode: header.mode,
        ack: header.ack,
        type: header.type,
        subtype: header.subtype,
        sequence: header.sequence,
        body: header.mode === 2 ? permute(body, true) : body.slice(),
      });
      pending = pending.subarray(size);
      header = undefined;
    }
  };
};

/** A little-endian reader over a reply body, returning 0 past the end. */
export const reader = (bytes: Uint8Array) => {
  const fields = view(bytes);
  const fits = (offset: number, size: number) => offset + size <= bytes.length;

  return {
    length: bytes.length,
    u8: (offset: number) => bytes[offset] ?? 0,
    u16: (offset: number) =>
      fits(offset, 2) ? fields.getUint16(offset, true) : 0,
    u32: (offset: number) =>
      fits(offset, 4) ? fields.getUint32(offset, true) : 0,
    i32: (offset: number) =>
      fits(offset, 4) ? fields.getInt32(offset, true) : 0,
    u64: (offset: number) =>
      fits(offset, 8) ? fields.getBigUint64(offset, true) : 0n,
    /** A NUL-terminated Latin-1 string in a fixed-size field. */
    text: (offset: number, size: number) => {
      const field = bytes.subarray(
        offset,
        Math.min(offset + size, bytes.length),
      );

      const end = field.indexOf(0);

      return new TextDecoder("latin1").decode(
        end === -1 ? field : field.subarray(0, end),
      );
    },
  };
};

export type Reader = ReturnType<typeof reader>;

/** A little-endian writer over a request body of a fixed size. */
export const writer = (size: number) => {
  const bytes = new Uint8Array(size);
  const fields = view(bytes);

  return {
    bytes,
    u32: (offset: number, value: number) =>
      fields.setUint32(offset, value >>> 0, true),
    u16: (offset: number, value: number) =>
      fields.setUint16(offset, value, true),
    u8: (offset: number, value: number) => {
      bytes[offset] = value;
    },
    /** Writes Latin-1 text into a fixed-size field, leaving room for a NUL. */
    text: (offset: number, size: number, value: string) => {
      for (let index = 0; index < Math.min(value.length, size - 1); index++) {
        bytes[offset + index] = value.charCodeAt(index) & 0xff;
      }
    },
  };
};

export type Writer = ReturnType<typeof writer>;
