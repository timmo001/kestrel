/**
 * Bytes taken from a stream as they're asked for, however its chunks fall:
 * a set number, up to a number, or what's left as a stream of its own. A
 * reader can put bytes back, so a caller can look at the start of a stream
 * before deciding how to read it.
 *
 * @module
 */
import { Cause, Effect, Pull, Stream, type Scope } from "effect";
import type * as Arr from "effect/Array";
import { TarError } from "./Errors.ts";

/** The largest chunk `rest` hands bytes on in. */
const chunkSize = 64 * 1024;

export const truncated = () =>
  new TarError({ message: "The archive ends part way through" });

export interface Reader<E> {
  /** Up to `most` bytes, or nothing where the stream has ended. */
  readonly take: (most: number) => Effect.Effect<Uint8Array | undefined, E>;
  /** Exactly `length` bytes, or nothing where the stream ended before any; it fails where it ends part way. */
  readonly exact: (
    length: number,
  ) => Effect.Effect<Uint8Array | undefined, E | TarError>;
  /** Passes over `length` bytes, failing where the stream ends first. */
  readonly skip: (length: number) => Effect.Effect<void, E | TarError>;
  /** Puts bytes back in front, to be read again. */
  readonly unread: (bytes: Uint8Array) => void;
  /** What's left, as a stream. */
  readonly rest: Stream.Stream<Uint8Array, E>;
}

/** A reader of `source`, for as long as the scope lasts. */
export const reader = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<Reader<E>, never, R | Scope.Scope> =>
  Effect.map(Stream.toPull(source), (pull) => fromPull(pull));

const fromPull = <E>(
  pull: Pull.Pull<Arr.NonEmptyReadonlyArray<Uint8Array>, E>,
): Reader<E> => {
  const queue: Array<Uint8Array> = [];
  let ended = false;

  const take = Effect.fnUntraced(function* (most: number) {
    while (queue.length === 0 && !ended) {
      const chunks = yield* Pull.catchDone(pull, () =>
        Effect.succeed(undefined),
      );

      if (chunks === undefined) {
        ended = true;
      } else {
        for (const chunk of chunks) if (chunk.length > 0) queue.push(chunk);
      }
    }

    const first = queue[0];

    if (first === undefined) return undefined;

    if (first.length <= most) {
      queue.shift();

      return first;
    }

    queue[0] = first.subarray(most);

    return first.subarray(0, most);
  });

  const exact = Effect.fnUntraced(function* (length: number) {
    const out = new Uint8Array(length);
    let filled = 0;

    while (filled < length) {
      const chunk = yield* take(length - filled);

      if (chunk === undefined) {
        if (filled === 0) return undefined;

        return yield* truncated();
      }

      out.set(chunk, filled);
      filled += chunk.length;
    }

    return out;
  });

  const skip = Effect.fnUntraced(function* (length: number) {
    let left = length;

    while (left > 0) {
      const chunk = yield* take(Math.min(left, chunkSize));

      if (chunk === undefined) return yield* truncated();

      left -= chunk.length;
    }
  });

  const rest = Stream.fromPull(
    Effect.succeed(
      Effect.flatMap(take(chunkSize), (chunk) => {
        if (chunk === undefined) return Cause.done();

        const one: Arr.NonEmptyReadonlyArray<Uint8Array> = [chunk];

        return Effect.succeed(one);
      }),
    ),
  );

  return {
    take,
    exact,
    skip,
    unread: (bytes) => {
      if (bytes.length > 0) queue.unshift(bytes);
    },
    rest,
  };
};
