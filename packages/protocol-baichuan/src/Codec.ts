/**
 * The wire format of Reolink's own protocol on port 9000, known as
 * Baichuan: a 20 or 24-byte header and a body, its XML scrambled with a
 * fixed XOR key until login and encrypted with AES after it. Follows the
 * open-source reolink_aio, neolink and nodelink-js clients.
 *
 * @module
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

/** Largest body accepted, so a bad length can't exhaust memory. */
export const maxBodySize = 16 * 1024 * 1024;

/** `f0 de bc 0a` at the start of every message. */
const magic = 0x0abcdef0;

/** The message classes, as the header carries them. */
export const MessageClass = {
  /** The first login message: a 20-byte header. */
  legacy: 0x6514,
  /** A reply with a 20-byte header. */
  short: 0x6614,
  /** A 24-byte header, with where the payload starts. */
  modern: 0x6414,
  /** A 24-byte header on replies and media. */
  plain: 0x0000,
  /** A 24-byte header on file downloads. */
  download: 0x6482,
} as const;

const longClasses = new Set<number>([
  MessageClass.modern,
  MessageClass.plain,
  MessageClass.download,
]);

const shortClasses = new Set<number>([MessageClass.legacy, MessageClass.short]);

/** One message: its extension XML, if any, and its payload. */
export interface Frame {
  readonly cmd: number;
  /** 250 for the device, a channel from 1, or a replay's own handle. */
  readonly channel: number;
  readonly message: number;
  /** 200 when it's done, 400 when refused, 0 on media. */
  readonly status: number;
  readonly extension: Uint8Array;
  readonly payload: Uint8Array;
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

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

/** Encodes one message; the legacy class has no payload offset. */
export const encodeFrame = (options: {
  readonly cmd: number;
  readonly channel: number;
  readonly message: number;
  readonly status?: number;
  readonly messageClass: number;
  readonly extension?: Uint8Array;
  readonly payload: Uint8Array;
}): Uint8Array => {
  const extension = options.extension ?? new Uint8Array(0);
  const long = options.messageClass !== MessageClass.legacy;
  const header = new Uint8Array(long ? 24 : 20);
  const fields = view(header);

  fields.setUint32(0, magic, true);
  fields.setUint32(4, options.cmd, true);
  fields.setUint32(8, extension.length + options.payload.length, true);
  fields.setUint8(12, options.channel & 0xff);
  fields.setUint16(14, options.message & 0xffff, true);
  fields.setUint16(16, options.status ?? 0, true);
  fields.setUint16(18, options.messageClass, true);

  if (long) fields.setUint32(20, extension.length, true);

  return concat(header, extension, options.payload);
};

/** The frames a chunk completed, and why reading stopped if the bytes made no sense. */
export interface Decoded {
  readonly frames: Array<Frame>;
  readonly problem?: string;
}

/**
 * Splits the bytes a device sends into frames. Feed it each chunk as it
 * arrives; it keeps a partial frame until the rest comes in. A class it
 * doesn't know has a payload offset when the four bytes after the short
 * header could be one.
 */
export const frameDecoder = () => {
  let pending = new Uint8Array(0);

  return (chunk: Uint8Array): Decoded => {
    pending = concat(pending, chunk);
    const frames: Array<Frame> = [];

    for (;;) {
      if (pending.length < 20) return { frames };

      const fields = view(pending);

      if (fields.getUint32(0, true) !== magic) {
        return { frames, problem: "It sent a message without the magic" };
      }

      const size = fields.getUint32(8, true);

      if (size > maxBodySize) {
        return {
          frames,
          problem: `It sent too large a message (${size} bytes)`,
        };
      }

      const messageClass = fields.getUint16(18, true);

      const known =
        longClasses.has(messageClass) || shortClasses.has(messageClass);

      if (!known && pending.length < 24) return { frames };

      const guess = known ? 0 : fields.getUint32(20, true);

      const long =
        longClasses.has(messageClass) ||
        (!known && guess >= 20 && guess <= size);

      const headerSize = long ? 24 : 20;

      if (pending.length < headerSize + size) return { frames };

      const offset = long ? Math.min(fields.getUint32(20, true), size) : 0;
      const body = pending.slice(headerSize, headerSize + size);

      frames.push({
        cmd: fields.getUint32(4, true),
        channel: fields.getUint8(12),
        message: fields.getUint16(14, true),
        status: fields.getUint16(16, true),
        extension: body.subarray(0, offset),
        payload: body.subarray(offset),
      });

      pending = pending.subarray(headerSize + size);
    }
  };
};

const xorKey = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];

/** The XOR scrambling used before login, keyed by the header's channel byte; it undoes itself. */
export const scramble = (bytes: Uint8Array, channel: number) =>
  bytes.map(
    (byte, index) =>
      byte ^ (xorKey[(channel + index) % 8] ?? 0) ^ (channel & 0xff),
  );

const iv = Buffer.from("0123456789abcdef", "utf8");

/** AES-128-CFB with the protocol's fixed IV, a fresh cipher for each message. */
export const cipher = (key: Uint8Array) => ({
  encrypt: (bytes: Uint8Array) => {
    const run = createCipheriv("aes-128-cfb", key, iv);

    return new Uint8Array(Buffer.concat([run.update(bytes), run.final()]));
  },
  decrypt: (bytes: Uint8Array) => {
    const run = createDecipheriv("aes-128-cfb", key, iv);

    return new Uint8Array(Buffer.concat([run.update(bytes), run.final()]));
  },
});

export type Cipher = ReturnType<typeof cipher>;

/** The protocol's MD5: the first 31 hex digits, in capitals. */
export const digest = (text: string) =>
  createHash("md5").update(text).digest("hex").slice(0, 31).toUpperCase();

/** The AES key for a login: from the device's nonce and the password. */
export const loginKey = (nonce: string, password: string) =>
  new TextEncoder().encode(digest(`${nonce}-${password}`).slice(0, 16));

const isXml = (text: string) => text.trimStart().startsWith("<");

/** XML from a message part, scrambled or encrypted, or `""` when it's neither. */
export const readXml = (
  bytes: Uint8Array,
  channel: number,
  aes: Cipher | undefined,
) => {
  if (bytes.length === 0) return "";

  const decoder = new TextDecoder();
  const unscrambled = decoder.decode(scramble(bytes, channel));

  if (isXml(unscrambled)) return unscrambled;

  if (aes !== undefined) {
    const decrypted = decoder.decode(aes.decrypt(bytes));

    if (isXml(decrypted)) return decrypted;
  }

  const plain = decoder.decode(bytes);

  return isXml(plain) ? plain : "";
};

/** One XML element's text, such as the `<nonce>` in a reply. */
export const element = (xml: string, name: string) =>
  new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml)?.[1];

const escapes = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&apos;"],
]);

/** Text made safe to put in an XML element. */
export const escapeXml = (text: string) =>
  text.replaceAll(/[&<>"']/g, (character) => escapes.get(character) ?? "");
