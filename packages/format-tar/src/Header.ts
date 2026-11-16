/**
 * A tar entry's header blocks: POSIX ustar, with a PAX extended header in
 * front when a path or size doesn't fit ustar's fields, as GNU and BSD tar
 * read them.
 *
 * @module
 */
import { TarError } from "./Errors.ts";

/** Everything in a tar archive comes in blocks of this many bytes. */
export const blockSize = 512;

/** What an entry is: a file with data, or a folder. */
export type EntryType = "file" | "directory";

/** What a header says about its entry. */
export interface EntryInfo {
  /** Where it goes, with forward slashes and no leading one, such as `config/sources.json`. */
  readonly path: string;
  readonly type: EntryType;
  /** In bytes; a folder's is 0. */
  readonly size: number;
  /** Its permissions, such as `0o600`. */
  readonly mode: number;
  /** When it last changed, in milliseconds since 1970. */
  readonly modified: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The largest number an octal field of `length` bytes holds, leaving room for its NUL. */
const octalLimit = (length: number) => 8 ** (length - 1) - 1;

/** Bytes needed to pad `size` to a whole block. */
export const padding = (size: number) =>
  (blockSize - (size % blockSize)) % blockSize;

const writeString = (
  block: Uint8Array,
  offset: number,
  length: number,
  text: string,
) => {
  block.set(encoder.encode(text).subarray(0, length), offset);
};

const writeOctal = (
  block: Uint8Array,
  offset: number,
  length: number,
  value: number,
) => {
  writeString(
    block,
    offset,
    length,
    `${Math.trunc(value)
      .toString(8)
      .padStart(length - 1, "0")}\0`,
  );
};

/** A number too big for octal, in GNU's base-256 form: the top bit set, then big-endian. */
const writeBase256 = (
  block: Uint8Array,
  offset: number,
  length: number,
  value: number,
) => {
  let rest = BigInt(Math.trunc(value));

  for (let at = offset + length - 1; at > offset; at--) {
    block[at] = Number(rest & 0xffn);
    rest >>= 8n;
  }

  block[offset] = 0x80;
};

/** A PAX record, `<length> <key>=<value>\n`, whose length counts itself. */
const paxRecord = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;

  while (String(length).length + bodyLength !== length) length++;

  return `${length}${body}`;
};

const checksum = (block: Uint8Array) => {
  let sum = 0;

  for (let at = 0; at < blockSize; at++) {
    sum += at >= 148 && at < 156 ? 32 : (block[at] ?? 0);
  }

  return sum;
};

/** One ustar header block. */
const ustar = (options: {
  readonly name: string;
  readonly flag: string;
  readonly size: number;
  readonly mode: number;
  readonly modified: number;
}) => {
  const block = new Uint8Array(blockSize);

  writeString(block, 0, 100, options.name);
  writeOctal(block, 100, 8, options.mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);

  if (options.size > octalLimit(12)) {
    writeBase256(block, 124, 12, options.size);
  } else {
    writeOctal(block, 124, 12, options.size);
  }

  writeOctal(block, 136, 12, Math.floor(options.modified / 1000));
  writeString(block, 156, 1, options.flag);
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  writeString(
    block,
    148,
    8,
    `${checksum(block).toString(8).padStart(6, "0")}\0 `,
  );

  return block;
};

/** Whether text is plain ASCII, which ustar's name field holds as it is. */
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/** The header blocks for an entry: a PAX header first where ustar's fields aren't enough. */
export const encodeHeader = (info: EntryInfo): Uint8Array => {
  const name = info.type === "directory" ? `${info.path}/` : info.path;
  const flag = info.type === "directory" ? "5" : "0";
  const size = info.type === "directory" ? 0 : info.size;

  const records = [
    ...(name.length > 100 || !isAscii(name) ? [paxRecord("path", name)] : []),
    ...(size > octalLimit(12) ? [paxRecord("size", String(size))] : []),
  ];

  const main = ustar({
    name: isAscii(name) ? name.slice(0, 100) : "",
    flag,
    size,
    mode: info.mode,
    modified: info.modified,
  });

  if (records.length === 0) return main;

  const pax = encoder.encode(records.join(""));

  const extended = ustar({
    name: "PaxHeader",
    flag: "x",
    size: pax.length,
    mode: 0o644,
    modified: info.modified,
  });

  const out = new Uint8Array(
    blockSize + pax.length + padding(pax.length) + blockSize,
  );

  out.set(extended, 0);
  out.set(pax, blockSize);
  out.set(main, out.length - blockSize);

  return out;
};

/** A NUL-ended string field. */
const readString = (block: Uint8Array, offset: number, length: number) => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);

  return decoder.decode(end === -1 ? field : field.subarray(0, end));
};

/** A number field, in octal or GNU's base-256. */
const readNumber = (block: Uint8Array, offset: number, length: number) => {
  const first = block[offset] ?? 0;

  if ((first & 0x80) !== 0) {
    let value = BigInt(first & 0x7f);

    for (let at = offset + 1; at < offset + length; at++) {
      value = (value << 8n) | BigInt(block[at] ?? 0);
    }

    return Number(value);
  }

  const text = readString(block, offset, length).trim();

  return text === "" ? 0 : Number.parseInt(text, 8);
};

/** What a raw header block says, before any PAX header is applied. */
export interface RawHeader {
  readonly name: string;
  readonly flag: string;
  readonly size: number;
  readonly mode: number;
  readonly modified: number;
}

/** Whether a block is all zeros, as the two that end an archive are. */
export const isZero = (block: Uint8Array) => block.every((byte) => byte === 0);

/** Reads a header block, checking its checksum. */
export const decodeHeader = (block: Uint8Array): RawHeader | TarError => {
  const stored = readNumber(block, 148, 8);

  if (stored !== checksum(block)) {
    return new TarError({
      message:
        "A header's checksum doesn't match: this isn't a whole tar archive",
    });
  }

  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  const magic = readString(block, 257, 6);

  return {
    name: magic === "ustar" && prefix !== "" ? `${prefix}/${name}` : name,
    flag: String.fromCharCode(block[156] ?? 0),
    size: readNumber(block, 124, 12),
    mode: readNumber(block, 100, 8),
    modified: readNumber(block, 136, 12) * 1000,
  };
};

/** A PAX header's records, by key. */
export const decodePax = (data: Uint8Array): Map<string, string> => {
  const records = new Map<string, string>();
  let at = 0;

  while (at < data.length) {
    const space = data.indexOf(32, at);

    if (space === -1) break;

    const length = Number.parseInt(
      decoder.decode(data.subarray(at, space)),
      10,
    );

    if (!Number.isFinite(length) || length <= 0) break;

    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");

    if (equals !== -1) {
      records.set(record.slice(0, equals), record.slice(equals + 1));
    }

    at += length;
  }

  return records;
};
