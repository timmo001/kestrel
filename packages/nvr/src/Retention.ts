/**
 * Clearing out old recordings. Footage recorded all the time and clips,
 * recorded for a reason such as motion, are kept for their own number of
 * hours, and the whole folder may use only a share of its disk, always
 * leaving some of the disk free. Past that, what's furthest through its
 * own hours goes first, so last week's clips go before this morning's
 * continuous footage. Only folders with the recordings
 * marker are touched, so a shared folder is safe, and a file written to in
 * the last few minutes is left alone, as it may still be being recorded.
 *
 * @module
 */
// oxlint-disable-next-line timmo-effect/prefer-platform-services -- Effect's FileSystem can't read a disk's size or free space
import { statfs } from "node:fs/promises";
import { Clock, Data, Effect, FileSystem, Option, Path } from "effect";
import { dayPattern, filePattern, isContinuous, marker } from "./Layout.ts";

const hour = 3_600_000;

/** Left free on the disk whatever the share, as a fraction of it. */
const freeFloor = 0.05;

/** Files written to this recently may still be being recorded. */
const settling = 2 * 60_000;

export interface RetentionOptions {
  /** The folder every camera's recordings go in. */
  readonly folder: string;
  /** How many hours of footage recorded all the time are kept. */
  readonly continuousHours: number;
  /** How many hours of clips are kept. */
  readonly clipHours: number;
  /** The most of its disk the folder may use, as a percentage. */
  readonly diskShare: number;
}

/** The disk a folder is on couldn't be read. */
export class DiskError extends Data.TaggedError("DiskError")<{
  readonly message: string;
}> {}

/** A disk's size and how much of it is free, in bytes. */
export interface Disk {
  readonly total: number;
  readonly free: number;
}

/** The disk a folder is on. */
export const disk = (folder: string) =>
  Effect.tryPromise({
    try: () => statfs(folder),
    catch: (cause) =>
      new DiskError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.map((stats): Disk => ({
      total: stats.blocks * stats.bsize,
      free: stats.bavail * stats.bsize,
    })),
  );

/**
 * How many bytes recordings may use in all, when they use `used` now: the
 * share of the disk, or less where that would leave too little of it free.
 */
export const budget = (
  options: Pick<RetentionOptions, "diskShare">,
  space: Disk,
  used: number,
) =>
  Math.max(
    0,
    Math.min(
      (space.total * options.diskShare) / 100,
      used + space.free - space.total * freeFloor,
    ),
  );

/** One recorded file, as clearing out sees it. */
export interface StoredFile {
  readonly path: string;
  /** When it starts, in milliseconds since 1970, by this machine's clock. */
  readonly time: number;
  readonly bytes: number;
  readonly continuous: boolean;
  /** When it was last written to, in milliseconds since 1970. */
  readonly modified: number;
}

/** Every recorded file in a folder's marked camera folders, oldest first. */
export const stored = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fs.exists(folder))) return [];

  const entries = yield* fs.readDirectory(folder, { recursive: true });

  const cameras = new Set(
    entries.flatMap((entry) =>
      path.basename(entry) === marker ? [path.dirname(entry)] : [],
    ),
  );

  const found = yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const dayFolder = path.dirname(entry);
        const date = path.basename(dayFolder);
        const match = filePattern.exec(path.basename(entry));

        if (
          match === null ||
          !dayPattern.test(date) ||
          !cameras.has(path.dirname(dayFolder))
        ) {
          return Option.none<StoredFile>();
        }

        const file = path.join(folder, entry);
        const info = yield* fs.stat(file);
        const [year, month, day] = date.split("-").map(Number);

        return Option.some<StoredFile>({
          path: file,
          time: new Date(
            year ?? 1970,
            (month ?? 1) - 1,
            day ?? 1,
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
          ).getTime(),
          bytes: Number(info.size),
          continuous: isContinuous(match[4]?.split("+") ?? []),
          modified: Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          }),
        });
      }).pipe(Effect.orElseSucceed(() => Option.none<StoredFile>())),
    { concurrency: 16 },
  );

  return found
    .flatMap((file) => Option.toArray(file))
    .toSorted((a, b) => a.time - b.time);
});

/**
 * How far through the hours its kind is kept a recording started at `time`
 * is, at `now`: 0.5 is halfway. Past the share, the furthest goes first.
 */
export const spent = (
  options: Pick<RetentionOptions, "continuousHours" | "clipHours">,
  file: Pick<StoredFile, "time" | "continuous">,
  now: number,
) =>
  (now - file.time) /
  ((file.continuous ? options.continuousHours : options.clipHours) * hour);

const sum = (files: ReadonlyArray<StoredFile>) =>
  files.reduce((total, file) => total + file.bytes, 0);

/** What a clear-out deleted. */
export interface Cleared {
  /** Files past their hours. */
  readonly expired: number;
  /** Files deleted for space. */
  readonly forSpace: number;
  readonly bytes: number;
}

/** Deletes the recordings past their hours, then the oldest while they use more than they may. */
export const prune = Effect.fnUntraced(function* (options: RetentionOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const files = yield* stored(options.folder);

  const settled = files.filter((file) => now - file.modified > settling);

  const expired = settled.filter(
    (file) =>
      file.time <
      now -
        (file.continuous ? options.continuousHours : options.clipHours) * hour,
  );

  const gone = new Set(expired);
  const kept = settled.filter((file) => !gone.has(file));
  const used = sum(files) - sum(expired);

  // The expired files' space is free once they're deleted
  const space = yield* disk(options.folder);

  let over =
    used -
    budget(
      options,
      { total: space.total, free: space.free + sum(expired) },
      used,
    );

  const forSpace: Array<StoredFile> = [];

  for (const file of kept.toSorted(
    (a, b) => spent(options, b, now) - spent(options, a, now),
  )) {
    if (over <= 0) break;

    forSpace.push(file);
    over -= file.bytes;
  }

  const removing = [...expired, ...forSpace];

  yield* Effect.forEach(
    removing,
    (file) => fs.remove(file.path, { force: true }).pipe(Effect.ignore),
    { discard: true },
  );

  // Day folders left empty go too
  yield* Effect.forEach(
    new Set(removing.map((file) => path.dirname(file.path))),
    (folder) =>
      fs.readDirectory(folder).pipe(
        Effect.flatMap((names) =>
          names.length === 0 ? fs.remove(folder) : Effect.void,
        ),
        Effect.ignore,
      ),
    { discard: true },
  );

  return {
    expired: expired.length,
    forSpace: forSpace.length,
    bytes: sum(removing),
  } satisfies Cleared;
});
