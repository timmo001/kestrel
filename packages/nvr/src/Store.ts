/**
 * Saving a recording copied from elsewhere, such as a recorder's own file,
 * into the recordings folder. It's written beside its final name and moved
 * there once whole, so the library and clearing out never see half a file,
 * and one left behind by a stop part way is cleared away next time.
 *
 * @module
 */
import { Effect, Exit, FileSystem, Path, Stream } from "effect";
import {
  InvalidKey,
  dayPattern,
  fileName,
  filePattern,
  isKey,
  marker,
} from "./Layout.ts";

/** What a file is called while it's being written. */
const partial = ".part";

export interface SaveOptions {
  /** The folder every camera's recordings go in. */
  readonly folder: string;
  /** The camera's own folder within it, such as `swann/1`. */
  readonly key: string;
  /** When it starts, local time, such as `2026-11-12T14:02:33`. */
  readonly begin: string;
  /** Its tags, such as `motion`. */
  readonly tags: ReadonlyArray<string>;
}

/** A camera's folder, or `InvalidKey` for a key that could reach outside the recordings folder. */
const cameraFolder = (folder: string, key: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    if (!isKey(key)) return yield* new InvalidKey({ key });

    return path.join(folder, ...key.split("/"));
  });

/** The local times files on a camera's day start at, such as `2026-11-12T14:02:33`, whatever their tags. */
export const starts = Effect.fnUntraced(function* (
  folder: string,
  key: string,
  date: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!dayPattern.test(date)) return new Set<string>();

  const names = yield* fs
    .readDirectory(path.join(yield* cameraFolder(folder, key), date))
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  return new Set(
    names.flatMap((name) => {
      const match = filePattern.exec(name);

      return match === null
        ? []
        : [`${date}T${match[1]}:${match[2]}:${match[3]}`];
    }),
  );
});

/** Saves a recording's bytes as a file in a camera's folder, and returns its path. */
export const save = <E, R>(
  options: SaveOptions,
  data: Stream.Stream<Uint8Array, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const camera = yield* cameraFolder(options.folder, options.key);
    const day = path.join(camera, options.begin.slice(0, 10));

    yield* fs.makeDirectory(day, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(path.join(camera, marker), "");

    const file = path.join(
      day,
      fileName(options.begin.slice(11, 19), options.tags),
    );

    const part = `${file}${partial}`;

    yield* data.pipe(
      Stream.run(fs.sink(part, { mode: 0o600 })),
      Effect.andThen(fs.rename(part, file)),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : fs.remove(part, { force: true }).pipe(Effect.ignore),
      ),
    );

    return file;
  });

/** Deletes files left part written in a folder's day folders, such as by a stop part way through a copy. */
export const clearPartial = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fs.exists(folder))) return 0;

  const left = (yield* fs.readDirectory(folder, { recursive: true })).filter(
    (entry) =>
      entry.endsWith(`.mp4${partial}`) &&
      dayPattern.test(path.basename(path.dirname(entry))),
  );

  yield* Effect.forEach(
    left,
    (entry) =>
      fs.remove(path.join(folder, entry), { force: true }).pipe(Effect.ignore),
    { discard: true },
  );

  return left.length;
});
