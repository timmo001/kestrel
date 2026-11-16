/**
 * Writing a tar archive as a stream: each entry's header, its bytes and the
 * padding to a whole block, then the two empty blocks that end it. Nothing
 * is held in memory beyond the chunk being passed on, so an archive can be
 * as large as the disk it goes to.
 *
 * @module
 */
import { Clock, Effect, Stream, type Scope } from "effect";
import { TarError } from "./Errors.ts";
import { blockSize, encodeHeader, padding } from "./Header.ts";

/** What an entry holds, read once its turn comes. */
export interface Content<E, R> {
  /** In bytes, as the header says; the data must be exactly this long. */
  readonly size: number;
  /** When it last changed, in milliseconds since 1970. */
  readonly modified: number;
  readonly data: Stream.Stream<Uint8Array, E, R>;
}

/** A file to write into an archive. */
export interface WriteEntry<E, R> {
  /** Where it goes, with forward slashes, such as `config/sources.json`. */
  readonly path: string;
  /** Its permissions, `0o600` by default. */
  readonly mode?: number | undefined;
  /**
   * Its size and bytes, opened when its turn comes, in a scope that lasts
   * while its bytes are written, so a file can be held open until then. An
   * entry that opens to nothing, such as a file that's gone, is left out.
   */
  readonly open: Effect.Effect<Content<E, R> | undefined, E, R | Scope.Scope>;
}

/** A file from bytes already in memory, such as a manifest. */
export const fromBytes = (
  path: string,
  bytes: Uint8Array,
  options?: { readonly mode?: number; readonly modified?: number },
): WriteEntry<never, never> => ({
  path,
  mode: options?.mode,
  open: Effect.map(Clock.currentTimeMillis, (now) => ({
    size: bytes.length,
    modified: options?.modified ?? now,
    data: Stream.make(bytes),
  })),
});

/** `data` checked to be `size` bytes long: cut where it runs over, failing where it falls short. */
const exactly = <E, R>(
  data: Stream.Stream<Uint8Array, E, R>,
  size: number,
  path: string,
) =>
  Stream.suspend(() => {
    let seen = 0;

    return data.pipe(
      Stream.map((chunk) => {
        const room = size - seen;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;

        seen += kept.length;

        return kept;
      }),
      Stream.filter((chunk) => chunk.length > 0),
      Stream.concat(
        Stream.suspend(() =>
          seen === size
            ? Stream.empty
            : Stream.fail(
                new TarError({
                  message: `${path} was ${size} bytes but only ${seen} could be read`,
                }),
              ),
        ),
      ),
    );
  });

/** The two empty blocks that end an archive. */
const end = new Uint8Array(blockSize * 2);

/** An archive of `entries`, in order, as a stream of bytes. */
export const write = <E, R, E2, R2>(
  entries: Stream.Stream<WriteEntry<E, R>, E2, R2>,
): Stream.Stream<Uint8Array, E | E2 | TarError, R | R2> =>
  entries.pipe(
    Stream.flatMap((entry) =>
      Stream.unwrap(
        Effect.map(entry.open, (content) => {
          if (content === undefined) return Stream.empty;

          const pad = padding(content.size);

          return Stream.make(
            encodeHeader({
              path: entry.path,
              type: "file",
              size: content.size,
              mode: entry.mode ?? 0o600,
              modified: content.modified,
            }),
          ).pipe(
            Stream.concat(exactly(content.data, content.size, entry.path)),
            Stream.concat(
              pad === 0 ? Stream.empty : Stream.make(new Uint8Array(pad)),
            ),
          );
        }),
      ),
    ),
    Stream.concat(Stream.make(end)),
  );
