/**
 * Copies each source's own recordings, such as a recorder's files, into the
 * recordings folder, so the library holds every recording and playback
 * never reaches a source. Every few minutes it lists what each source has
 * from within the hours kept, and copies what isn't there yet one file at a
 * time, at full quality: clips first, then continuous footage, newest first.
 * Past the disk share, a file is only copied when something older would be
 * cleared out for it, and the clear-out runs straight after, so the newest
 * are kept and nothing is copied only to be deleted.
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
  Schedule,
} from "effect";
import { ownRecordingsFolder } from "./Folders.ts";
import { reasonTag } from "./Library.ts";
import { Sources } from "./Sources.ts";

/** How long between looks at what the sources have. */
const every = Duration.minutes(10);

/** A recording that ended this recently may still be being written. */
const settling = 5 * 60_000;

/** The longest one file may take to copy. */
const longest = Duration.minutes(30);

const hour = 3_600_000;

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

/** Copies one recording into the folder. */
const copy = (folder: string, want: Wanted) =>
  Effect.gen(function* () {
    const video = want.source.recordings?.video;

    if (video === undefined) return;

    const frames = yield* video({
      camera: want.recording.camera,
      begin: want.recording.begin,
      end: want.recording.end,
      stream: "main",
    });

    yield* Nvr.Store.save(
      {
        folder,
        key: want.recording.camera,
        begin: want.recording.begin,
        tags: want.tags,
      },
      Mp4.toMp4(frames),
    );
  }).pipe(Effect.timeout(longest));

/** Whether a clear-out would delete something older than this to make room for it. */
const roomFor = (
  stored: ReadonlyArray<Nvr.StoredFile>,
  want: Wanted,
  begin: string,
) =>
  stored.some(
    (file) =>
      (file.continuous &&
        (!want.continuous || Nvr.localTime(file.time) < begin)) ||
      (!want.continuous && Nvr.localTime(file.time) < begin),
  );

const sum = (files: ReadonlyArray<Nvr.StoredFile>) =>
  files.reduce((total, file) => total + file.bytes, 0);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sources = yield* Sources;
    const fs = yield* FileSystem.FileSystem;
    const own = yield* ownRecordingsFolder;

    const pass = Effect.gen(function* () {
      const settings = (yield* sources.settings).recording;
      const folder = settings.folder ?? own;

      yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
      yield* Nvr.Store.clearPartial(folder);

      const found = yield* Effect.forEach(yield* sources.all, (source) =>
        wanted(source, folder, settings).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
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

      if (queue.length === 0) return;

      yield* Effect.logInfo(`Copying ${queue.length} recordings from sources`);

      const stored = yield* Ref.make(yield* Nvr.stored(folder));
      const copied = yield* Ref.make({ files: 0, bytes: 0 });

      yield* Effect.forEach(
        queue,
        (want) =>
          Effect.gen(function* () {
            const files = yield* Ref.get(stored);
            const used = sum(files);
            const bytes = want.recording.bytes ?? 0;
            const space = yield* Nvr.disk(folder);
            const fits = used + bytes <= Nvr.budget(settings, space, used);

            if (!fits && !roomFor(files, want, want.recording.begin)) return;

            yield* copy(folder, want);

            yield* Ref.update(copied, (total) => ({
              files: total.files + 1,
              bytes: total.bytes + bytes,
            }));

            if (!fits) yield* Nvr.prune({ ...settings, folder });

            yield* Ref.set(stored, yield* Nvr.stored(folder));
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `${want.recording.camera} from ${want.recording.begin} can't be copied: ${String(error)}`,
              ),
            ),
          ),
        { discard: true },
      );

      const total = yield* Ref.get(copied);

      yield* Effect.logInfo(
        `Copied ${total.files} recordings from sources, ${(total.bytes / 1e9).toFixed(1)} GB`,
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Recordings can't be copied: ${String(error)}`),
      ),
    );

    // Gives the sources a moment to connect first
    yield* Effect.sleep(Duration.seconds(30)).pipe(
      Effect.andThen(pass),
      Effect.repeat(Schedule.spaced(every)),
      Effect.forkScoped,
    );
  }),
);
