/**
 * The work the server does by itself, such as copying recordings from
 * sources, recording each camera and clearing out old recordings, and how
 * each is getting on, for the page, the CLI and the API. Each job reports
 * its own; a job's `since` moves when its state does.
 *
 * @module
 */
import { Clock, Context, Effect, Layer, Ref } from "effect";
import { ActivityLog } from "./ActivityLog.ts";
import type { Job } from "./Api.ts";

/** A job's next report, from its last, or nothing to drop it. */
export type JobChange = (job: Job | undefined) => Job | undefined;

/** Whether `after` brings a different `at` from `before`. */
const isNew = (
  before: { readonly at: string } | undefined,
  after: { readonly at: string } | undefined,
) => after !== undefined && after.at !== before?.at;

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
      const log = yield* ActivityLog;
      const jobs = yield* Ref.make(new Map<string, Job>());

      const update = (id: string, change: JobChange) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis).toISOString();

          const [before, after] = yield* Ref.modify(jobs, (current) => {
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

            return [[before, after] as const, next];
          });

          // Each new error and finished run goes in the activity log
          if (after === undefined) return;

          if (isNew(before?.lastError, after.lastError)) {
            yield* log.add({
              job: id,
              name: after.name,
              level: "error",
              message: after.lastError?.message ?? "",
            });
          }

          if (isNew(before?.lastRun, after.lastRun)) {
            yield* log.add({
              job: id,
              name: after.name,
              level: "info",
              message: after.lastRun?.summary ?? "",
            });
          }
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
