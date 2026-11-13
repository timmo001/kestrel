/**
 * Copies each source's own recordings, such as a recorder's files, into the
 * recordings folder, so the library holds every recording and playback
 * never reaches a source. Every few minutes it lists what each source has
 * from within the hours kept, and copies what isn't there yet one file at a
 * time, at full quality: clips first, then continuous footage, newest first.
 * A long queue hands back every few minutes and lists again, so clips that
 * came in meanwhile go ahead of older ones still waiting.
 * Past the disk share, a file is only copied when something older would be
 * cleared out for it, and the clear-out runs straight after, so the newest
 * are kept and nothing is copied only to be deleted. Copies read no faster
 * than the copy rate in the limits, and wait, even part way through a file,
 * while Kestrel or the machine is past one; the copy job says how it's
 * getting on.
 *
 * @module
 */
import type { Recording, Source } from "@timmo001/kestrel-core";
import * as Mp4 from "@timmo001/kestrel-format-mp4";
import * as Nvr from "@timmo001/kestrel-nvr";
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Ref,
  Stream,
} from "effect";
import type { CopySource, Job } from "./Api.ts";
import { ownRecordingsFolder } from "./Folders.ts";
import { Jobs } from "./Jobs.ts";
import { reasonTag } from "./Library.ts";
import { Sources } from "./Sources.ts";
import { Usage } from "./Usage.ts";

/** How long between looks at what the sources have, and the longest a look's copying runs before looking again. */
const every = Duration.minutes(10);

/** A recording that ended this recently may still be being written. */
const settling = 5 * 60_000;

/** The longest one file may take to copy. */
const longest = Duration.minutes(30);

const hour = 3_600_000;

const megabyte = 1024 * 1024;

/** How many of the newest copied recordings the copy job lists. */
const listed = 20;

const day = 24 * hour;

interface Wanted {
  readonly source: Source;
  readonly recording: Recording;
  readonly tags: ReadonlyArray<string>;
  readonly continuous: boolean;
}

/** What one source has that the folder doesn't, from within the hours kept. */
const wanted = Effect.fnUntraced(function* (
  source: Source,
  folder: string,
  limits: { readonly continuousHours: number; readonly clipHours: number },
) {
  const recordings = source.recordings;

  // A source that only lists its recordings has nothing to copy
  if (recordings?.video === undefined) return [];

  const now = yield* Clock.currentTimeMillis;
  const settled = Nvr.localTime(now - settling);
  const longestHours = Math.max(limits.continuousHours, limits.clipHours);
  const earliest = now - longestHours * hour;

  const months = new Set(
    Array.from({ length: Math.ceil(longestHours / 24) + 1 }, (_, index) =>
      Nvr.localDate(now - index * day).slice(0, 7),
    ),
  );

  const days = yield* Effect.forEach(months, (month) => recordings.days(month));

  const dates = days
    .flat()
    .map((each) => each.date)
    .filter((date) => date >= Nvr.localDate(earliest));

  const cameras = (yield* source.cameras).filter((camera) => camera.recordings);

  const found = yield* Effect.forEach(cameras, (camera) =>
    Effect.forEach(dates, (date) =>
      Effect.gen(function* () {
        const listed = yield* recordings.list(camera.id, date);
        const present = yield* Nvr.Store.starts(folder, camera.id, date);

        return listed.flatMap((recording): Array<Wanted> => {
          const tags = recording.reasons.map(reasonTag);
          const continuous = Nvr.isContinuous(tags);

          const kept = Nvr.localTime(
            now -
              (continuous ? limits.continuousHours : limits.clipHours) * hour,
          );

          return recording.begin >= kept &&
            recording.end <= settled &&
            !present.has(recording.begin)
            ? [{ source, recording, tags, continuous }]
            : [];
        });
      }),
    ),
  );

  return found.flat(2);
});

/**
 * Copies one recording into the folder, reading no faster than `rate` MB a
 * second and waiting part way through while `room` says to, and returns
 * its path.
 */
const copy = (
  folder: string,
  want: Wanted,
  rate: number,
  room: Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const video = want.source.recordings?.video;

    if (video === undefined) return undefined;

    const frames = yield* video({
      camera: want.recording.camera,
      begin: want.recording.begin,
      end: want.recording.end,
      stream: "main",
      pace: { bytesPerSecond: rate * megabyte, room },
    });

    const perSecond = rate * megabyte;

    return yield* Nvr.Store.save(
      {
        folder,
        key: want.recording.camera,
        begin: want.recording.begin,
        tags: want.tags,
      },
      Mp4.toMp4(frames).pipe(
        Stream.tap(() => room),
        Stream.throttle({
          cost: (chunks) =>
            chunks.reduce((total, chunk) => total + chunk.length, 0),
          units: perSecond,
          duration: Duration.seconds(1),
          burst: perSecond,
          strategy: "shape",
        }),
      ),
    );
  }).pipe(
    // Slow copies of big files get longer, at twice the time they need
    Effect.timeout(
      Duration.max(
        longest,
        Duration.seconds(((want.recording.bytes ?? 0) / (rate * megabyte)) * 2),
      ),
    ),
  );

/**
 * Whether a clear-out would delete something further through its hours
 * than this to make room for it, rather than this straight after.
 */
const roomFor = (
  stored: ReadonlyArray<Nvr.StoredFile>,
  want: Wanted,
  limits: { readonly continuousHours: number; readonly clipHours: number },
  now: number,
) => {
  // A recording's time is this machine's local time, as the files' names are
  const wanted = Nvr.spent(
    limits,
    {
      time: new Date(want.recording.begin).getTime(),
      continuous: want.continuous,
    },
    now,
  );

  return stored.some((file) => Nvr.spent(limits, file, now) > wanted);
};

const sum = (files: ReadonlyArray<Nvr.StoredFile>) =>
  files.reduce((total, file) => total + file.bytes, 0);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sources = yield* Sources;
    const fs = yield* FileSystem.FileSystem;
    const own = yield* ownRecordingsFolder;
    const jobs = yield* Jobs;
    const usage = yield* Usage;

    const fresh: Job = {
      id: "copy",
      kind: "copy",
      name: "Copy recordings from sources",
      state: "idle",
      detail: "Starts shortly",
      since: "",
    };

    const report = (change: (job: Job) => Job) =>
      jobs.update(fresh.id, (job) => change(job ?? fresh));

    const at = Clock.currentTimeMillis.pipe(
      Effect.map((now) => new Date(now).toISOString()),
    );

    /** What the job says while it works, kept for after a wait. */
    const doing = yield* Ref.make("Looking at what sources have");

    const working = (detail: string) =>
      Ref.set(doing, detail).pipe(
        Effect.andThen(report((job) => ({ ...job, state: "running", detail }))),
      );

    /** Waits while background work should, saying why in the job. */
    const room = usage
      .whenRoom((reason) =>
        report((job) => ({
          ...job,
          state: "waiting",
          detail: `Waiting: ${reason}`,
        })),
      )
      .pipe(
        Effect.tap((waited) =>
          waited ? Ref.get(doing).pipe(Effect.flatMap(working)) : Effect.void,
        ),
      );

    const failed = (message: string) =>
      Effect.gen(function* () {
        const now = yield* at;

        yield* Effect.logWarning(message);
        yield* report((job) => ({ ...job, lastError: { at: now, message } }));
      });

    const pass = Effect.gen(function* () {
      const settings = (yield* sources.settings).recording;
      const folder = settings.folder ?? own;
      const rate = settings.limits.copyRate;

      yield* working("Looking at what sources have");
      yield* room;
      yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
      yield* Nvr.Store.clearPartial(folder);

      const found = yield* Effect.forEach(yield* sources.all, (source) =>
        wanted(source, folder, settings).pipe(
          Effect.catch((error) =>
            failed(
              `Recordings from ${source.id} can't be listed: ${String(error)}`,
            ).pipe(Effect.as([])),
          ),
        ),
      );

      const newestFirst = (a: Wanted, b: Wanted) =>
        b.recording.begin.localeCompare(a.recording.begin);

      const queue = [
        ...found
          .flat()
          .filter((want) => !want.continuous)
          .toSorted(newestFirst),
        ...found
          .flat()
          .filter((want) => want.continuous)
          .toSorted(newestFirst),
      ];

      const bySource = new Map<string, CopySource>(
        found
          .flat()
          .map((want) => [
            want.source.id,
            { source: want.source.id, copied: 0, left: 0, bytes: 0 },
          ]),
      );

      for (const want of queue) {
        const was = bySource.get(want.source.id);

        if (was !== undefined) {
          bySource.set(want.source.id, { ...was, left: was.left + 1 });
        }
      }

      const progress = { done: 0, total: queue.length, bytes: 0 };

      const tally = (want: Wanted, bytes: number) => {
        const was = bySource.get(want.source.id);

        progress.done += 1;
        progress.bytes += bytes;

        if (was !== undefined) {
          bySource.set(want.source.id, {
            ...was,
            copied: was.copied + (bytes > 0 ? 1 : 0),
            left: was.left - 1,
            bytes: was.bytes + bytes,
          });
        }

        return report((job) => ({
          ...job,
          progress: { ...progress },
          sources: [...bySource.values()],
        }));
      };

      yield* report((job) => ({
        ...job,
        progress: { ...progress },
        sources: [...bySource.values()],
      }));

      if (queue.length > 0) {
        yield* Effect.logInfo(
          `Copying ${queue.length} recordings from sources, at up to ${rate} MB a second`,
        );
      }

      const stored = yield* Ref.make(yield* Nvr.stored(folder));
      const copied = yield* Ref.make({ files: 0, bytes: 0 });
      const started = yield* Clock.currentTimeMillis;

      // A long queue hands back now and then, so newer clips go first
      let cut = false;

      yield* Effect.forEach(
        queue,
        (want) =>
          Effect.gen(function* () {
            if (cut) return;

            const now = yield* Clock.currentTimeMillis;

            if (now - started > Duration.toMillis(every)) {
              cut = true;

              return;
            }

            const files = yield* Ref.get(stored);
            const used = sum(files);
            const space = yield* Nvr.disk(folder);

            const fits =
              used + (want.recording.bytes ?? 0) <=
              Nvr.budget(settings, space, used);

            if (!fits && !roomFor(files, want, settings, now)) {
              return yield* tally(want, 0);
            }

            yield* working(
              `Copying ${want.recording.camera} from ${want.recording.begin.replace("T", " ")}`,
            );
            yield* room;

            const file = yield* copy(folder, want, rate, room);

            if (file === undefined) return yield* tally(want, 0);

            const bytes = Number((yield* fs.stat(file)).size);
            const when = yield* at;

            yield* Ref.update(copied, (total) => ({
              files: total.files + 1,
              bytes: total.bytes + bytes,
            }));

            yield* tally(want, bytes);

            yield* report((job) => ({
              ...job,
              recent: [
                {
                  camera: want.recording.camera,
                  begin: want.recording.begin,
                  bytes,
                  at: when,
                },
                ...(job.recent ?? []),
              ].slice(0, listed),
            }));

            if (fits) {
              // Counting the folder again reads every file, so add this one
              yield* Ref.update(stored, (all) => [
                ...all,
                {
                  path: file,
                  time: new Date(want.recording.begin).getTime(),
                  bytes,
                  continuous: want.continuous,
                  modified: now,
                },
              ]);
            } else {
              yield* Nvr.prune({ ...settings, folder });
              yield* Ref.set(stored, yield* Nvr.stored(folder));
            }
          }).pipe(
            Effect.catch((error) =>
              failed(
                `${want.recording.camera} from ${want.recording.begin} can't be copied: ${String(error)}`,
              ).pipe(Effect.andThen(tally(want, 0))),
            ),
          ),
        { discard: true },
      );

      const total = yield* Ref.get(copied);
      const summary = `Copied ${total.files} recordings, ${(total.bytes / 1e9).toFixed(1)} GB`;
      const now = yield* at;

      if (queue.length > 0) {
        yield* Effect.logInfo(
          cut
            ? `${summary} from sources, looking again for newer ones`
            : `${summary} from sources`,
        );
      }

      yield* report((job) => ({
        ...job,
        state: cut ? "running" : "idle",
        detail: cut
          ? "Looking again for newer recordings"
          : "Looks again in 10 minutes",
        lastRun: { at: now, summary },
      }));

      return cut;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = `Recordings can't be copied: ${String(error)}`;
          const now = yield* at;

          yield* Effect.logWarning(message);
          yield* report((job) => ({
            ...job,
            state: "failed",
            detail: "Tries again in 10 minutes",
            lastError: { at: now, message },
          }));

          return false;
        }),
      ),
    );

    yield* report((job) => job);

    // Gives the sources a moment to connect first, and goes straight on
    // after a look that handed back with more to copy
    yield* Effect.sleep(Duration.seconds(30)).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          for (;;) {
            if (!(yield* pass)) yield* Effect.sleep(every);
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
