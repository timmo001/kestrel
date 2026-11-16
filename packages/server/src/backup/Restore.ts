/**
 * Restoring a backup, in two steps. Reading it stages its files in
 * `restore.partial` in the state folder, moved to `restore` once the whole
 * backup has been read and checked, so one that fails part way changes
 * nothing. The server then restarts, and puts what's staged in place before
 * anything reads its files: the settings and the server's own files over
 * what's here, and the recordings into the recordings folder the restored
 * settings name, beside the ones here or in their place.
 *
 * @module
 */
import * as Tar from "@timmo001/kestrel-format-tar";
import * as Nvr from "@timmo001/kestrel-nvr";
import { Data, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { BackupError, RestoreMode } from "../Api.ts";
import { configFolder, ownRecordingsFolder, stateFolder } from "../Folders.ts";
import * as SourcesFile from "../SourcesFile.ts";
import { Manifest, manifestJson, manifestPath, place } from "./Contents.ts";
import * as Lock from "./Lock.ts";

const readyName = "restore";
const partialName = "restore.partial";
const failedName = "restore.failed";
const planName = "restore.json";

/** The largest manifest read, so a damaged one can't fill memory. */
const manifestLimit = 1024 * 1024;

/** What's staged, and what to do with the recordings already here. */
const Plan = Schema.fromJsonString(
  Schema.Struct({ recordings: RestoreMode, manifest: Manifest }),
);

const decodePlan = Schema.decodeUnknownEffect(Plan);

const encodePlan = Schema.encodeSync(Plan);

const decodeManifest = Schema.decodeUnknownOption(manifestJson);

/** Keeps what's here for files that are in both. */
const Lengths = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

const decodeLengths = Schema.decodeUnknownOption(Lengths);

const notABackup = () =>
  new BackupError({ message: "That isn't a Kestrel backup" });

const join = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, each) => sum + each.length, 0));
  let at = 0;

  for (const each of parts) {
    out.set(each, at);
    at += each.length;
  }

  return out;
};

/** A backup's manifest, from its first file, failing where it doesn't start with one. */
const readManifest = <E>(entry: Tar.ReadEntry<E>) =>
  Effect.gen(function* () {
    if (entry.path !== manifestPath || entry.size > manifestLimit) {
      return yield* notABackup();
    }

    const text = new TextDecoder().decode(
      join(yield* Stream.runCollect(entry.data)),
    );

    return yield* Option.match(decodeManifest(text), {
      onNone: () =>
        Effect.fail(
          new BackupError({
            message: "This backup was made by a newer Kestrel, or it's damaged",
          }),
        ),
      onSome: Effect.succeed,
    });
  });

/** Stops reading a backup once its manifest is found. */
class Found extends Data.TaggedError("Found")<{
  readonly manifest: Manifest;
}> {}

const asBackupError = (error: { readonly message: string }) =>
  error instanceof BackupError
    ? error
    : new BackupError({
        message: `The backup couldn't be read: ${error.message}`,
      });

/**
 * A backup's manifest, read from its start, which also checks the
 * passphrase of a locked one, without reading the rest.
 */
export const manifestOf = <E extends { readonly message: string }>(
  source: Stream.Stream<Uint8Array, E>,
  passphrase: string | undefined,
) =>
  Tar.read(Lock.unlock(source, passphrase), (entry) =>
    readManifest(entry).pipe(
      Effect.flatMap((manifest) => Effect.fail(new Found({ manifest }))),
    ),
  ).pipe(
    Effect.flatMap(() => Effect.fail(notABackup())),
    Effect.catch((error) =>
      error instanceof Found
        ? Effect.succeed(error.manifest)
        : Effect.fail(asBackupError(error)),
    ),
  );

export interface StageOptions {
  readonly recordings: RestoreMode;
  readonly passphrase?: string | undefined;
  /** Called after each file, with how many there have been of how many, and their bytes. */
  readonly progress: (
    files: number,
    total: number,
    bytes: number,
  ) => Effect.Effect<void>;
}

/**
 * Reads a backup and stages its files for the next start, returning its
 * manifest. Nothing here changes until the server restarts.
 */
export const stage = <E extends { readonly message: string }>(
  source: Stream.Stream<Uint8Array, E>,
  options: StageOptions,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const state = yield* stateFolder;
    const partial = path.join(state, partialName);
    const ready = path.join(state, readyName);

    yield* fs.remove(partial, { recursive: true, force: true });
    yield* fs.makeDirectory(partial, { recursive: true, mode: 0o700 });

    let manifest: Manifest | undefined;
    let files = 0;
    let bytes = 0;

    const staging = Tar.read(Lock.unlock(source, options.passphrase), (entry) =>
      Effect.gen(function* () {
        if (manifest === undefined) {
          manifest = yield* readManifest(entry);

          return;
        }

        const placed = place(entry.path);

        if (placed === undefined) {
          return yield* Effect.logDebug(
            `Passed over ${entry.path}, which a backup doesn't hold`,
          );
        }

        const file = path.join(partial, placed.area, ...placed.parts);
        const modified = new Date(entry.modified);

        yield* fs.makeDirectory(path.dirname(file), {
          recursive: true,
          mode: 0o700,
        });
        yield* Stream.run(entry.data, fs.sink(file, { mode: 0o600 }));
        // The library tells how long a recording really ran from when it last changed
        yield* fs.utimes(file, modified, modified);

        files += 1;
        bytes += entry.size;

        yield* options.progress(files, manifest.files, bytes);
      }),
    );

    yield* staging;

    if (manifest === undefined) return yield* notABackup();

    yield* fs.writeFileString(
      path.join(partial, planName),
      encodePlan({ recordings: options.recordings, manifest }),
      { mode: 0o600 },
    );
    yield* fs.remove(ready, { recursive: true, force: true });
    yield* fs.rename(partial, ready);

    return manifest;
  }).pipe(
    Effect.tapError(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs
          .remove(path.join(yield* stateFolder, partialName), {
            recursive: true,
            force: true,
          })
          .pipe(Effect.ignore);
      }),
    ),
    Effect.mapError(asBackupError),
  );

/**
 * Moves a file over `to`, keeping when it last changed. Across disks, such
 * as from the state folder to a Home Assistant app's media folder, it's
 * copied beside `to` first, then moved over it.
 */
const move = (from: string, to: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.rename(from, to).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          const info = yield* fs.stat(from);
          const next = `${to}.restoring`;
          const modified = Option.getOrElse(info.mtime, () => new Date());

          yield* fs.copyFile(from, next);
          yield* fs.chmod(next, 0o600);
          yield* fs.utimes(next, modified, modified);
          yield* fs.rename(next, to);
          yield* fs.remove(from);
        }),
      ),
    );
  });

const namesIn = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
  });

/** Puts a staged day's kept lengths beside the ones here, keeping these where both have a file. */
const mergeLengths = (from: string, to: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staged = decodeLengths(yield* fs.readFileString(from));
    const here = decodeLengths(yield* fs.readFileString(to));

    if (Option.isSome(staged) && Option.isSome(here)) {
      yield* fs.writeFileString(
        to,
        JSON.stringify({ ...staged.value, ...here.value }),
        { mode: 0o600 },
      );
    }

    yield* fs.remove(from);
  });

const applyStaged = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* stateFolder;
  const config = yield* configFolder;
  const ready = path.join(state, readyName);
  const planFile = path.join(ready, planName);

  const plan = yield* decodePlan(yield* fs.readFileString(planFile));
  const { manifest } = plan;

  yield* Effect.logInfo(
    `Restoring the backup of ${manifest.server} made ${manifest.created}`,
  );

  for (const [area, folder] of [
    ["config", config],
    ["state", state],
  ] as const) {
    const from = path.join(ready, area);

    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });

    for (const name of yield* namesIn(from)) {
      yield* move(path.join(from, name), path.join(folder, name));
    }
  }

  // The restored settings say where recordings go. A folder that isn't on
  // this machine, such as a backup's from another one, is left to this
  // server, as copying a setup does
  const settings = yield* SourcesFile.read(config).pipe(
    Effect.orElseSucceed(() => undefined),
  );

  const named = settings?.recording.folder ?? null;

  const here =
    named !== null &&
    (yield* fs.stat(named).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    ));

  if (settings !== undefined && named !== null && !here) {
    yield* Effect.logWarning(
      `The backup's recordings folder, ${named}, isn't on this machine, so its recordings go in this server's own`,
    );
    yield* SourcesFile.write(config, {
      ...settings,
      recording: { ...settings.recording, folder: null },
    });
  }

  const recordings = here ? named : yield* ownRecordingsFolder;

  if (plan.recordings === "replace") {
    for (const key of yield* Nvr.Library.cameras(recordings)) {
      yield* fs.remove(path.join(recordings, ...key.split("/")), {
        recursive: true,
      });
    }

    // Done once, so starting again part way doesn't clear what's moved since
    yield* fs.writeFileString(
      planFile,
      encodePlan({ ...plan, recordings: "merge" }),
      { mode: 0o600 },
    );
  }

  const from = path.join(ready, "recordings");

  const entries = yield* fs
    .readDirectory(from, { recursive: true })
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  let moved = 0;
  let kept = 0;

  for (const entry of entries.toSorted()) {
    const source = path.join(from, entry);
    const info = yield* fs.stat(source);

    if (info.type !== "File") continue;

    const target = path.join(recordings, entry);

    yield* fs.makeDirectory(path.dirname(target), {
      recursive: true,
      mode: 0o700,
    });

    const recorded = Nvr.filePattern.test(path.basename(entry));

    if (!(yield* fs.exists(target))) {
      yield* move(source, target);

      if (recorded) moved += 1;
    } else if (path.basename(entry) === Nvr.lengthsFile) {
      yield* mergeLengths(source, target);
    } else {
      // A file both have is the same recording, so the one here stays
      yield* fs.remove(source);

      if (recorded) kept += 1;
    }
  }

  yield* fs.remove(ready, { recursive: true });

  yield* Effect.logInfo(
    `Restored the backup: ${moved} recorded files moved in${kept === 0 ? "" : `, ${kept} already here`}`,
  );
});

/**
 * Puts a staged restore in place, if there is one, before the server
 * starts. One that fails is moved to `restore.failed` in the state folder
 * and logged, so the server still starts.
 */
export const applyPending = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* stateFolder;
  const ready = path.join(state, readyName);

  if (!(yield* fs.exists(ready).pipe(Effect.orElseSucceed(() => false)))) {
    return;
  }

  yield* applyStaged.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const failed = path.join(state, failedName);

        yield* Effect.logError(
          `The backup couldn't be restored, so it's kept in ${failed}: ${String(error)}`,
        );
        yield* fs.remove(failed, { recursive: true, force: true });
        yield* fs.rename(ready, failed);
      }).pipe(Effect.ignore),
    ),
  );
});
