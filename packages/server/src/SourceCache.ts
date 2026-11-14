/**
 * Keeps what a source answered for a little while, so a page loading again,
 * or several asking at once, don't each ask the source again. Its cameras
 * and details are kept for a few seconds. Its recorded days and lists are
 * kept briefly while the day or month is still going, and for longer once
 * it's past, when only the source clearing out old footage changes them.
 * Failures aren't kept, and a save that restarts a source starts it with
 * nothing kept.
 *
 * @module
 */
import type {
  CameraId,
  Source,
  SourceRecordings,
} from "@timmo001/kestrel-core";
import * as Nvr from "@timmo001/kestrel-nvr";
import { Cache, Clock, Duration, Effect, Exit } from "effect";
import type { Mutable } from "effect/Types";

/** How long answers that change from moment to moment are kept, such as which cameras have a picture. */
const briefly = Duration.seconds(10);

/** How long recordings of today, or this month, are kept: less than the recordings page waits to read them again. */
const changing = Duration.seconds(15);

/** How long recordings of a day or month that's past are kept. */
const settled = Duration.minutes(10);

const day = 86_400_000;

/** Keeps a success for `ttl`; a failure is asked again. */
const successFor =
  (ttl: Duration.Duration) =>
  <A, E>(exit: Exit.Exit<A, E>) =>
    Exit.isSuccess(exit) ? ttl : 0;

/** An answer, kept briefly. */
const keep = <A, E>(effect: Effect.Effect<A, E>) =>
  Cache.makeWith<void, A, E>(() => effect, {
    capacity: 1,
    timeToLive: successFor(briefly),
  }).pipe(Effect.map((cache) => Cache.get(cache, undefined)));

/**
 * Answers by key, kept briefly while what they're about may still change and
 * longer once `past` says it's over. `past` gets the local date a day ago, so
 * a source with a clock a little ahead of the server's is covered.
 */
const keepBy = <K, A, E>(
  lookup: (key: K) => Effect.Effect<A, E>,
  capacity: number,
  past: (key: K, dayAgo: string) => boolean,
) => {
  const make = (ttl: Duration.Duration) =>
    Cache.makeWith(lookup, { capacity, timeToLive: successFor(ttl) });

  return Effect.all([make(changing), make(settled)]).pipe(
    Effect.map(
      ([current, older]) =>
        (key: K) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Cache.get(
                past(key, Nvr.localDate(now - day)) ? older : current,
                key,
              ),
            ),
          ),
    ),
  );
};

const keepRecordings = (recordings: SourceRecordings) =>
  Effect.all([
    keepBy(
      recordings.days,
      64,
      (month: string, dayAgo) => month < dayAgo.slice(0, 7),
    ),
    keepBy(
      (key: { readonly camera: CameraId; readonly date: string }) =>
        recordings.list(key.camera, key.date),
      1024,
      (key, dayAgo) => key.date < dayAgo,
    ),
  ]).pipe(
    Effect.map(([days, list]): SourceRecordings => ({
      ...recordings,
      days,
      list: (camera, date) => list({ camera, date }),
    })),
  );

/** A source that keeps what it answered for a while. */
export const cached = Effect.fnUntraced(function* (source: Source) {
  const kept: Mutable<Source> = {
    ...source,
    cameras: yield* keep(source.cameras),
  };

  if (source.details !== undefined) {
    kept.details = yield* keep(source.details);
  }

  if (source.recordings !== undefined) {
    kept.recordings = yield* keepRecordings(source.recordings);
  }

  return kept;
});
