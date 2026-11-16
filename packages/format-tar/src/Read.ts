/**
 * Reading a tar archive as a stream: each file's header, then its bytes as
 * a stream of their own, handed to the caller in turn. Bytes a caller
 * doesn't read are skipped, so it can pass over what it doesn't want.
 * Folders, links and other kinds of entry are passed over; a PAX header's
 * path and size, or GNU tar's long name, apply to the entry after it.
 *
 * @module
 */
import { Cause, Effect, Stream } from "effect";
import type * as Arr from "effect/Array";
import { reader, truncated } from "./Bytes.ts";
import { TarError } from "./Errors.ts";
import {
  blockSize,
  decodeHeader,
  decodePax,
  isZero,
  padding,
  type EntryInfo,
} from "./Header.ts";

/** A file read from an archive. */
export interface ReadEntry<E> extends EntryInfo {
  /** Its bytes, which can be read once, while the caller handles it. */
  readonly data: Stream.Stream<Uint8Array, E | TarError>;
}

/** The largest chunk an entry's bytes are handed on in. */
const chunkSize = 64 * 1024;

/**
 * Reads an archive, handing each file to `handle` in turn, and returns how
 * many there were. An archive that stops part way, or whose headers don't
 * check out, fails with `TarError`.
 */
export const read = <E, R, E2, R2>(
  source: Stream.Stream<Uint8Array, E, R>,
  handle: (entry: ReadEntry<E>) => Effect.Effect<void, E2, R2>,
) =>
  Effect.gen(function* () {
    const bytes = yield* reader(source);
    let pax = new Map<string, string>();
    let files = 0;

    while (true) {
      const block = yield* bytes.exact(blockSize);

      // An archive ends with two empty blocks, but some writers leave them out
      if (block === undefined || isZero(block)) break;

      const header = decodeHeader(block);

      if (header instanceof TarError) return yield* header;

      const size = Number(pax.get("size") ?? header.size);
      const path = (pax.get("path") ?? header.name).replace(/^\.?\/+/, "");
      const after = padding(size);

      if (header.flag === "x" || header.flag === "L") {
        const data = yield* bytes.exact(size);

        if (data === undefined) return yield* truncated();

        // GNU tar's own long name, as its default format writes one
        pax =
          header.flag === "x"
            ? decodePax(data)
            : new Map([
                ["path", new TextDecoder().decode(data).replace(/\0+$/, "")],
              ]);

        yield* bytes.skip(after);
        continue;
      }

      pax = new Map();

      if (header.flag !== "0" && header.flag !== "\0") {
        yield* bytes.skip(size + after);
        continue;
      }

      let left = size;

      const data = Stream.fromPull(
        Effect.succeed(
          Effect.gen(function* () {
            if (left === 0) return yield* Cause.done();

            const chunk = yield* bytes.take(Math.min(left, chunkSize));

            if (chunk === undefined) return yield* truncated();

            left -= chunk.length;

            const one: Arr.NonEmptyReadonlyArray<Uint8Array> = [chunk];

            return one;
          }),
        ),
      );

      yield* handle({
        path,
        type: "file",
        size,
        mode: header.mode,
        modified: header.modified,
        data,
      });

      yield* bytes.skip(left + after);
      files++;
    }

    return files;
  }).pipe(Effect.scoped);
