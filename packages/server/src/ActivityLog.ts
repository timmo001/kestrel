/**
 * The activity log: each job's errors and finished runs, kept in
 * `activity.jsonl` in the state folder so they outlast a restart. It keeps
 * the last 7 days, up to 5 MB, dropping the oldest first, so it can't fill a
 * small machine's disk.
 *
 * @module
 */
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import { LogEntry, type LogLevel } from "./Api.ts";
import { stateFolder } from "./Folders.ts";

/** How long it keeps an entry. */
const keepFor = 7 * 24 * 60 * 60 * 1000;

/** The most the file takes, in bytes. */
const keepBytes = 5 * 1024 * 1024;

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(LogEntry));

const lineBytes = (entry: LogEntry) =>
  new TextEncoder().encode(JSON.stringify(entry)).length + 1;

/** The newest entries that are under 7 days old and fit in 5 MB, oldest first. */
const kept = (entries: ReadonlyArray<LogEntry>, now: number) => {
  const fresh = entries.filter(
    (entry) => now - Date.parse(entry.at) <= keepFor,
  );

  let bytes = 0;
  let from = fresh.length;

  while (from > 0) {
    const entry = fresh[from - 1];

    if (entry === undefined) break;

    const next = bytes + lineBytes(entry);

    if (next > keepBytes) break;

    bytes = next;
    from -= 1;
  }

  return { entries: fresh.slice(from), bytes };
};

export class ActivityLog extends Context.Service<
  ActivityLog,
  {
    readonly add: (entry: Omit<LogEntry, "at">) => Effect.Effect<void>;
    /** Newest first. */
    readonly list: (options: {
      readonly job?: string | undefined;
      readonly level?: LogLevel | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<Array<LogEntry>>;
  }
>()("@timmo001/kestrel-server/ActivityLog") {
  static readonly layer = Layer.effect(
    ActivityLog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* stateFolder;
      const file = path.join(directory, "activity.jsonl");

      const loaded = yield* fs.readFileString(file).pipe(
        Effect.map((text) =>
          text
            .split("\n")
            .flatMap((line) =>
              line === "" ? [] : Option.toArray(decodeEntry(line)),
            ),
        ),
        Effect.orElseSucceed((): Array<LogEntry> => []),
      );

      const state = yield* Ref.make(
        kept(loaded, yield* Clock.currentTimeMillis),
      );

      const warn = (error: { readonly message: string }) =>
        Effect.logWarning(`Couldn't write the activity log: ${error.message}`);

      /** Writes the file again with only what it keeps. */
      const rewrite = Effect.gen(function* () {
        const { entries } = yield* Ref.get(state);

        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });

        yield* fs.writeFileString(
          file,
          entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
          { mode: 0o600 },
        );
      }).pipe(Effect.catch(warn));

      // Drops what's past keeping from the start
      if (loaded.length !== (yield* Ref.get(state)).entries.length) {
        yield* rewrite;
      }

      const writing = yield* Semaphore.make(1);

      const add = Effect.fn("ActivityLog.add")(
        function* (entry: Omit<LogEntry, "at">) {
          const now = yield* Clock.currentTimeMillis;
          const full: LogEntry = { at: new Date(now).toISOString(), ...entry };
          const before = yield* Ref.get(state);
          const bytes = before.bytes + lineBytes(full);

          // Past 5 MB, or with the oldest past 7 days, it writes the whole file
          // again without them; otherwise it adds the line to its end
          const oldest = before.entries[0];

          const prune =
            bytes > keepBytes ||
            (oldest !== undefined && now - Date.parse(oldest.at) > keepFor);

          if (prune) {
            yield* Ref.set(state, kept([...before.entries, full], now));
            yield* rewrite;

            return;
          }

          yield* Ref.set(state, { entries: [...before.entries, full], bytes });

          yield* fs
            .makeDirectory(directory, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.andThen(
                fs.writeFileString(file, `${JSON.stringify(full)}\n`, {
                  flag: "a",
                  mode: 0o600,
                }),
              ),
              Effect.catch(warn),
            );
        },
        (effect) => writing.withPermit(effect),
      );

      return ActivityLog.of({
        add,
        list: ({ job, level, limit = 200 }) =>
          Ref.get(state).pipe(
            Effect.map(({ entries }) =>
              entries
                .filter(
                  (entry) =>
                    (job === undefined || entry.job === job) &&
                    (level === undefined || entry.level === level),
                )
                .toReversed()
                .slice(0, limit),
            ),
          ),
      });
    }),
  );
}
