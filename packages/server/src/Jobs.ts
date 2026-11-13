/**
 * The work the server does by itself, such as copying recordings from
 * sources, recording each camera and clearing out old recordings, and how
 * each is getting on, for the page, the CLI and the API. Each job reports
 * its own; a job's `since` moves when its state does.
 *
 * @module
 */
import { Clock, Context, Effect, Layer, Ref } from "effect";
import type { Job } from "./Api.ts";

/** A job's next report, from its last, or nothing to drop it. */
export type JobChange = (job: Job | undefined) => Job | undefined;

export class Jobs extends Context.Service<
  Jobs,
  {
    readonly list: Effect.Effect<Array<Job>>;
    readonly update: (id: string, change: JobChange) => Effect.Effect<void>;
    readonly remove: (id: string) => Effect.Effect<void>;
  }
>()("@timmo001/kestrel-server/Jobs") {
  static readonly layer = Layer.effect(
    Jobs,
    Effect.gen(function* () {
      const jobs = yield* Ref.make(new Map<string, Job>());

      const update = (id: string, change: JobChange) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis).toISOString();

          yield* Ref.update(jobs, (current) => {
            const before = current.get(id);
            const after = change(before);
            const next = new Map(current);

            if (after === undefined) {
              next.delete(id);
            } else {
              next.set(id, {
                ...after,
                since:
                  before === undefined || before.state !== after.state
                    ? now
                    : before.since,
              });
            }

            return next;
          });
        });

      return Jobs.of({
        list: Ref.get(jobs).pipe(
          Effect.map((current) =>
            [...current.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
          ),
        ),
        update,
        remove: (id) => update(id, () => undefined),
      });
    }),
  );
}
