/**
 * Locking a backup with a passphrase, and opening it again. A locked
 * backup starts with `KESTRELX`, a format byte, the scrypt salt and a base
 * nonce, then the archive in AES-256-GCM parts of up to 1 MiB, each with a
 * 4-byte length whose top bit marks the last. Each part's nonce and checked
 * data carry its number and whether it's last, so parts can't be dropped,
 * moved or cut off without opening failing. A backup without a passphrase
 * is a plain tar archive.
 *
 * @module
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import { Bytes, type TarError } from "@timmo001/kestrel-format-tar";
import { Cause, Effect, Stream, type Scope } from "effect";
import type * as Arr from "effect/Array";
import { BackupError, lockedMark } from "../Api.ts";

const magic = new TextEncoder().encode(lockedMark);

const format = 1;
const saltLength = 16;
const nonceLength = 12;
const tagLength = 16;
const partSize = 1024 * 1024;
const lastPart = 0x80000000;

/** Whether a backup's first bytes say it's locked. */
export const isLocked = (start: Uint8Array) =>
  start.length >= magic.length &&
  magic.every((byte, index) => start[index] === byte);

/** The bytes `magic` takes, for reading the start of a backup. */
export const startLength = magic.length;

const keyFor = (passphrase: string, salt: Uint8Array) =>
  Effect.callback<Uint8Array, BackupError>((resume) => {
    scrypt(
      passphrase.normalize("NFKC"),
      salt,
      32,
      { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        resume(
          error
            ? Effect.fail(
                new BackupError({
                  message: `The passphrase couldn't be used: ${error.message}`,
                }),
              )
            : Effect.succeed(key),
        );
      },
    );
  });

/** A part's nonce: the base with its number mixed into the last 8 bytes. */
const nonceFor = (base: Uint8Array, part: number) => {
  const nonce = Uint8Array.from(base);
  const view = new DataView(nonce.buffer);

  view.setBigUint64(4, view.getBigUint64(4) ^ BigInt(part));

  return nonce;
};

/** What each part's tag also checks: its number and whether it's last. */
const checkedFor = (part: number, last: boolean) => {
  const checked = new Uint8Array(9);
  const view = new DataView(checked.buffer);

  view.setBigUint64(0, BigInt(part));
  checked[8] = last ? 1 : 0;

  return checked;
};

const join = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, each) => sum + each.length, 0));
  let at = 0;

  for (const each of parts) {
    out.set(each, at);
    at += each.length;
  }

  return out;
};

/** Up to `length` bytes, fewer only where the stream ends. */
const upTo = <E>(bytes: Bytes.Reader<E>, length: number) =>
  Effect.gen(function* () {
    const parts: Array<Uint8Array> = [];
    let filled = 0;

    while (filled < length) {
      const chunk = yield* bytes.take(length - filled);

      if (chunk === undefined) break;

      parts.push(chunk);
      filled += chunk.length;
    }

    return join(parts);
  });

const one = (bytes: Uint8Array): Arr.NonEmptyReadonlyArray<Uint8Array> => [
  bytes,
];

/** `source` locked with `passphrase`. */
export const lock = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  passphrase: string,
): Stream.Stream<Uint8Array, E | BackupError, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const salt = randomBytes(saltLength);
      const base = randomBytes(nonceLength);
      const key = yield* keyFor(passphrase, salt);
      const bytes = yield* Bytes.reader(source);
      let part = 0;
      let done = false;

      const parts = Stream.fromPull(
        Effect.succeed(
          Effect.gen(function* () {
            if (done) return yield* Cause.done();

            const plain = yield* upTo(bytes, partSize);
            const after = yield* bytes.take(partSize);
            const last = after === undefined;

            if (after !== undefined) bytes.unread(after);

            const cipher = createCipheriv(
              "aes-256-gcm",
              key,
              nonceFor(base, part),
            );

            cipher.setAAD(checkedFor(part, last));

            const sealed = join([cipher.update(plain), cipher.final()]);
            const length = new Uint8Array(4);

            new DataView(length.buffer).setUint32(
              0,
              (plain.length | (last ? lastPart : 0)) >>> 0,
            );

            part += 1;
            done = last;

            return one(join([length, sealed, cipher.getAuthTag()]));
          }),
        ),
      );

      return Stream.make(join([magic, Uint8Array.of(format), salt, base])).pipe(
        Stream.concat(parts),
      );
    }),
  );

const wrong = () =>
  new BackupError({
    message: "The passphrase is wrong, or the backup is damaged",
  });

/**
 * A backup's archive: opened with `passphrase` where it's locked, or as it
 * is where it isn't.
 */
export const unlock = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  passphrase: string | undefined,
): Stream.Stream<Uint8Array, E | BackupError | TarError, R> =>
  Stream.unwrap(
    Effect.gen(function* (): Effect.fn.Return<
      Stream.Stream<Uint8Array, E | BackupError | TarError>,
      E | BackupError | TarError,
      R | Scope.Scope
    > {
      const bytes = yield* Bytes.reader(source);
      const start = yield* upTo(bytes, magic.length);

      if (!isLocked(start)) {
        bytes.unread(start);

        return bytes.rest;
      }

      if (passphrase === undefined || passphrase === "") {
        return yield* new BackupError({
          message: "This backup is locked: give its passphrase",
        });
      }

      const header = yield* bytes.exact(1 + saltLength + nonceLength);

      if (header === undefined || header[0] !== format) {
        return yield* new BackupError({
          message: "This backup was made by a newer Kestrel",
        });
      }

      const salt = header.subarray(1, 1 + saltLength);
      const base = header.subarray(1 + saltLength);
      const key = yield* keyFor(passphrase, salt);
      let part = 0;
      let done = false;

      return Stream.fromPull(
        Effect.succeed(
          Effect.gen(function* () {
            if (done) return yield* Cause.done();

            const length = yield* bytes.exact(4);

            if (length === undefined) {
              return yield* new BackupError({
                message: "The backup ends before its last part",
              });
            }

            const word = new DataView(length.buffer).getUint32(0);
            const last = (word & lastPart) !== 0;
            const size = word & ~lastPart;

            if (size > partSize) return yield* wrong();

            const sealed = yield* bytes.exact(size + tagLength);

            if (sealed === undefined) return yield* wrong();

            const plain = yield* Effect.try({
              try: () => {
                const decipher = createDecipheriv(
                  "aes-256-gcm",
                  key,
                  nonceFor(base, part),
                );

                decipher.setAAD(checkedFor(part, last));
                decipher.setAuthTag(sealed.subarray(size));

                return join([
                  decipher.update(sealed.subarray(0, size)),
                  decipher.final(),
                ]);
              },
              catch: wrong,
            });

            part += 1;
            done = last;

            return one(plain);
          }),
        ),
      ).pipe(Stream.filter((chunk) => chunk.length > 0));
    }),
  );
