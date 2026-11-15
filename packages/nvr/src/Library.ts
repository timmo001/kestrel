/**
 * Reading the recordings folder back: the days a camera has files on, and
 * each file on a day with when it starts and ends and its tags. A file's end
 * comes from reading its length, kept while the file's size stays the same,
 * so a file still being written is read again as it grows. What's read is
 * kept in each day folder too, so a restart doesn't read every file again,
 * which takes minutes for a busy day on a small machine.
 *
 * @module
 */
import * as Mp4 from "@timmo001/kestrel-format-mp4";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  InvalidKey,
  dayPattern,
  filePattern,
  isKey,
  lengthsFile,
  marker,
} from "./Layout.ts";

/** One recorded file. */
export interface RecordedFile {
  readonly path: string;
  /** The local day it's in, such as `2026-11-12`. */
  readonly date: string;
  /** When it starts, local time, such as `2026-11-12T14:02:33`. */
  readonly begin: string;
  /** How long it really ran, in seconds. */
  readonly duration: number;
  /**
   * How many real seconds each of its own took: above 1 where the camera's
   * clock ran slow, so its frames are spread out to fill the time.
   */
  readonly stretch: number;
  /** Its tags, such as `motion`. */
  readonly tags: ReadonlyArray<string>;
  readonly bytes: number;
  /** Whether the camera wove a second picture into it, which reading leaves out. */
  readonly mixed: boolean;
}

/** A day with files, and every tag on them. */
export interface RecordedDay {
  readonly date: string;
  readonly tags: ReadonlyArray<string>;
  /** Whether any file on it has no tags, such as one recorded all the time. */
  readonly untagged: boolean;
}

const Length = Schema.Struct({
  bytes: Schema.Finite,
  duration: Schema.Finite,
  mixed: Schema.Boolean,
});

type Length = typeof Length.Type;

/** A day folder's kept lengths, by file name. */
const Lengths = Schema.fromJsonString(Schema.Record(Schema.String, Length));

const decodeLengths = Schema.decodeUnknownOption(Lengths);

const encodeLengths = Schema.encodeSync(Lengths);

/** What's been read of each file so far, by path, with the size it was read at. */
const lengths = new Map<string, Length>();

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

/** How much longer than its own timing a file must have run to be stretched, and by at least how many seconds. */
const slowAfter = { ratio: 1.25, seconds: 10 };

/** Past this stretch the file was more likely copied or touched since than recorded that slowly. */
const stretchLimit = 4;

/**
 * How many real seconds each second of a file Kestrel recorded took. Some
 * cameras' RTSP times frames at a rate they don't keep up, as in the dark,
 * so a file's own timing runs short of the time it took. ffmpeg writes each
 * file as the video arrives, so when it last changed is when it really
 * ended. Copies keep their source's timing and aren't stretched, nor are
 * files that only lag by a fragment still to come.
 */
const stretchOf = (
  begin: string,
  duration: number,
  tags: ReadonlyArray<string>,
  modified: Option.Option<Date>,
) => {
  if (tags.length > 0 || duration <= 0 || Option.isNone(modified)) return 1;

  // Without an offset, a date and time is read as local time
  const real = (modified.value.getTime() - new Date(begin).getTime()) / 1000;
  const stretch = real / duration;

  return stretch >= slowAfter.ratio &&
    real - duration >= slowAfter.seconds &&
    stretch <= stretchLimit
    ? stretch
    : 1;
};

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
  const keptFile = path.join(dayFolder, lengthsFile);

  const kept = yield* fs.readFileString(keptFile).pipe(
    Effect.map(decodeLengths),
    Effect.orElseSucceed(() => Option.none()),
    Effect.map(Option.getOrElse((): Record<string, Length> => ({}))),
  );

  // Whether any file was read afresh, so what's kept needs writing again
  let changed = false;

  const found = yield* Effect.forEach(
    (yield* namesIn(dayFolder)).toSorted(),
    (name) =>
      Effect.gen(function* () {
        const match = filePattern.exec(name);

        if (match === null) return Option.none<RecordedFile>();

        const file = path.join(dayFolder, name);
        const info = yield* fs.stat(file);
        const bytes = Number(info.size);
        const known = lengths.get(file) ?? kept[name];

        const { duration, mixed } =
          known?.bytes === bytes ? known : yield* Mp4.info(file);

        if (known?.bytes !== bytes || kept[name]?.bytes !== bytes) {
          changed = true;
        }

        lengths.set(file, { bytes, duration, mixed });

        const begin = `${date}T${match[1]}:${match[2]}:${match[3]}`;
        const tags = tagsOf(match);
        const stretch = stretchOf(begin, duration, tags, info.mtime);

        return Option.some<RecordedFile>({
          path: file,
          date,
          begin,
          duration: duration * stretch,
          stretch,
          tags,
          bytes,
          mixed,
        });
      }).pipe(Effect.orElseSucceed(() => Option.none<RecordedFile>())),
    { concurrency: 8 },
  );

  const recorded = found.flatMap((file) => Option.toArray(file));

  if (changed) {
    // Written aside and moved into place, so a reader never sees half of it
    const part = `${keptFile}.${crypto.randomUUID()}`;

    const contents = encodeLengths(
      Object.fromEntries(
        recorded.map(({ path: file, bytes, duration, mixed }) => [
          path.basename(file),
          { bytes, duration, mixed },
        ]),
      ),
    );

    yield* fs.writeFileString(part, contents).pipe(
      Effect.andThen(fs.rename(part, keptFile)),
      Effect.catch(() => fs.remove(part, { force: true })),
      Effect.ignore,
    );
  }

  return recorded;
});
