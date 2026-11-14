/**
 * Checks what a source's answers are kept for: past days' recordings for
 * longer than today's, and failures not at all.
 */
import {
  SourceUnavailable,
  type Recording,
  type Source,
} from "@timmo001/kestrel-core";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { cached } from "./SourceCache.ts";

const camera = "swann/1";

/** A source that counts what it's asked, failing its first `failing` lists. */
const counting = (failing = 0) => {
  const asked: Array<string> = [];
  const unavailable = Effect.fail(new SourceUnavailable({ message: "down" }));

  const source: Source = {
    id: "swann",
    kind: "raysharp",
    name: "Recorder",
    connection: Effect.succeed({ connected: true, since: null, error: null }),
    attention: Effect.succeed([]),
    cameras: unavailable,
    live: unavailable,
    recordings: {
      days: () => Effect.succeed([]),
      list: (_, date) =>
        Effect.suspend(() => {
          asked.push(date);

          return asked.length <= failing
            ? unavailable
            : Effect.succeed<Array<Recording>>([]);
        }),
    },
  };

  return { asked, source };
};

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    TestClock.setTime(new Date(2026, 10, 14, 12).getTime()).pipe(
      Effect.andThen(effect),
      Effect.provide(TestClock.layer()),
    ),
  );

test("a past day's list is kept for longer than today's", async () => {
  const { asked, source } = counting();

  await run(
    Effect.gen(function* () {
      const list = (yield* cached(source)).recordings?.list;

      if (list === undefined) return;

      for (const date of ["2026-11-14", "2026-11-10"]) {
        yield* list(camera, date);
        yield* list(camera, date);
      }

      yield* TestClock.adjust("1 minute");
      yield* list(camera, "2026-11-14");
      yield* list(camera, "2026-11-10");
    }),
  );

  expect(asked).toEqual(["2026-11-14", "2026-11-10", "2026-11-14"]);
});

test("a failure is asked again", async () => {
  const { asked, source } = counting(1);

  await run(
    Effect.gen(function* () {
      const list = (yield* cached(source)).recordings?.list;

      if (list === undefined) return;

      yield* Effect.exit(list(camera, "2026-11-10"));
      yield* list(camera, "2026-11-10");
      yield* list(camera, "2026-11-10");
    }),
  );

  expect(asked).toEqual(["2026-11-10", "2026-11-10"]);
});
