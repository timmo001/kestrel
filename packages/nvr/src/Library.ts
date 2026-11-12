/**
 * Reading the recordings folder back: the days a camera has files on, and
 * each file on a day with when it starts and ends and its tags. A file's end
 * comes from reading its length, kept while the file's size stays the same,
 * so a file still being written is read again as it grows.
 *
 * @module
 */
import * as Mp4 from "@timmo001/kestrel-format-mp4";
import { Effect, FileSystem, Option, Path } from "effect";
import {
  InvalidKey,
  dayPattern,
  filePattern,
  isKey,
  marker,
} from "./Layout.ts";

/** One recorded file. */
export interface RecordedFile {
  readonly path: string;
  /** The local day it's in, such as `2026-11-12`. */
  readonly date: string;
  /** When it starts, local time, such as `2026-11-12T14:02:33`. */
  readonly begin: string;
  /** How long it runs, in seconds. */
  readonly duration: number;
  /** Its tags, such as `motion`. */
  readonly tags: ReadonlyArray<string>;
  readonly bytes: number;
}

/** A day with files, and every tag on them. */
export interface RecordedDay {
  readonly date: string;
  readonly tags: ReadonlyArray<string>;
  /** Whether any file on it has no tags, such as one recorded all the time. */
  readonly untagged: boolean;
}

/** Lengths read so far, by path, with the size they were read at. */
const lengths = new Map<
  string,
  { readonly bytes: number; readonly duration: number }
>();

/** A camera's folder, or `InvalidKey` for a key that could reach outside the recordings folder. */
const cameraFolder = (folder: string, key: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    if (!isKey(key)) return yield* new InvalidKey({ key });

    return path.join(folder, ...key.split("/"));
  });

/** A folder's names, or none when it isn't there. */
const namesIn = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
  });

/**
 * The keys of every camera with a folder in the recordings folder, such as
 * `front-door/1`, looking a few folders deep.
 */
export const cameras = Effect.fnUntraced(function* (folder: string) {
  const path = yield* Path.Path;

  const walk = (
    relative: ReadonlyArray<string>,
    depth: number,
  ): Effect.Effect<Array<string>, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const names = yield* namesIn(path.join(folder, ...relative));

      if (relative.length > 0 && names.includes(marker)) {
        return [relative.join("/")];
      }

      if (depth === 0) return [];

      const nested = yield* Effect.forEach(
        names.filter((name) => !dayPattern.test(name) && !name.startsWith(".")),
        (name) => walk([...relative, name], depth - 1),
      );

      return nested.flat();
    });

  return yield* walk([], 3);
});

/** The tags in a file's name. */
const tagsOf = (match: RegExpExecArray) => match[4]?.split("+") ?? [];

/** The days in a month, such as `2026-11`, a camera has files on, with their tags. */
export const days = Effect.fnUntraced(function* (
  folder: string,
  key: string,
  month: string,
) {
  const path = yield* Path.Path;
  const own = yield* cameraFolder(folder, key);

  const dates = (yield* namesIn(own))
    .filter((name) => dayPattern.test(name) && name.startsWith(`${month}-`))
    .toSorted();

  const found = yield* Effect.forEach(dates, (date) =>
    namesIn(path.join(own, date)).pipe(
      Effect.map((names): Option.Option<RecordedDay> => {
        const matches = names.flatMap((name) => {
          const match = filePattern.exec(name);

          return match === null ? [] : [match];
        });

        return matches.length === 0
          ? Option.none()
          : Option.some({
              date,
              tags: [...new Set(matches.flatMap(tagsOf))],
              untagged: matches.some((match) => tagsOf(match).length === 0),
            });
      }),
    ),
  );

  return found.flatMap((day) => Option.toArray(day));
});

/** A camera's files on a day, such as `2026-11-12`, earliest first. A file that can't be read is left out. */
export const files = Effect.fnUntraced(function* (
  folder: string,
  key: string,
  date: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!dayPattern.test(date)) return [];

  const dayFolder = path.join(yield* cameraFolder(folder, key), date);

  const found = yield* Effect.forEach(
    (yield* namesIn(dayFolder)).toSorted(),
    (name) =>
      Effect.gen(function* () {
        const match = filePattern.exec(name);

        if (match === null) return Option.none<RecordedFile>();

        const file = path.join(dayFolder, name);
        const bytes = Number((yield* fs.stat(file)).size);
        const known = lengths.get(file);

        const duration =
          known?.bytes === bytes
            ? known.duration
            : (yield* Mp4.info(file)).duration;

        lengths.set(file, { bytes, duration });

        return Option.some<RecordedFile>({
          path: file,
          date,
          begin: `${date}T${match[1]}:${match[2]}:${match[3]}`,
          duration,
          tags: tagsOf(match),
          bytes,
        });
      }).pipe(Effect.orElseSucceed(() => Option.none<RecordedFile>())),
    { concurrency: 8 },
  );

  return found.flatMap((file) => Option.toArray(file));
});
