/**
 * Backups: made in the backups folder, in the state folder, or streamed
 * straight to a download as they're made, and restored from either or from
 * an upload. One backup or restore runs at a time, as the `backup` or
 * `restore` job. A restore stages the backup, then restarts the server,
 * which puts it in place before anything reads its files.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import * as Tar from "@timmo001/kestrel-format-tar";
import {
  Cause,
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import type * as Arr from "effect/Array";
import {
  BackupError,
  type BackupFile,
  type BackupRequest,
  type Job,
  type RestoreMode,
  UnknownBackup,
} from "./Api.ts";
import * as Contents from "./backup/Contents.ts";
import * as Lock from "./backup/Lock.ts";
import * as Restore from "./backup/Restore.ts";
import { configFolder, ownRecordingsFolder, stateFolder } from "./Folders.ts";
import { Identity } from "./Identity.ts";
import { Jobs } from "./Jobs.ts";
import { Restart } from "./Restart.ts";
import { Sources } from "./Sources.ts";

/** What every backup's name ends in. */
export const extension = ".kestrel-backup";

/** The names of backups the server made, the only ones it reads or removes. */
const namePattern = /^kestrel-[\w-]+\.kestrel-backup$/;

/** How long a download link works for. */
const linkLife = 5 * 60 * 1000;

/** How much of a recording is read at a time. */
const chunkSize = 64 * 1024;

const encodeManifest = Schema.encodeSync(Contents.manifestJson);

/** A backup on its way to a download. */
export interface Download {
  readonly name: string;
  readonly data: Stream.Stream<Uint8Array, BackupError>;
}

export interface RestoreOptions {
  readonly recordings: RestoreMode;
  readonly passphrase?: string | undefined;
}

export class Backups extends Context.Service<
  Backups,
  {
    /** The backups in the backups folder, newest first. */
    readonly list: Effect.Effect<Array<BackupFile>>;
    /** Starts making a backup in the backups folder, and says its name. */
    readonly create: (
      request: BackupRequest,
    ) => Effect.Effect<string, BackupError>;
    /** A one-time code that downloads a new backup, made as `request` asks. */
    readonly link: (request: BackupRequest) => Effect.Effect<string>;
    /** The backup a download code makes; the code then stops working. */
    readonly download: (code: string) => Effect.Effect<Download, UnknownBackup>;
    /** A backup in the backups folder, as it's stored. */
    readonly file: (name: string) => Effect.Effect<Download, UnknownBackup>;
    readonly remove: (name: string) => Effect.Effect<void, UnknownBackup>;
    /**
     * Checks a backup in the backups folder can be opened, then restores it
     * in the background, restarting the server once it's read.
     */
    readonly restore: (
      name: string,
      options: RestoreOptions,
    ) => Effect.Effect<void, UnknownBackup | BackupError>;
    /** Restores the backup `data` carries, restarting the server once it's read. */
    readonly upload: <E extends { readonly message: string }>(
      data: Stream.Stream<Uint8Array, E>,
      options: RestoreOptions,
    ) => Effect.Effect<void, BackupError>;
  }
>()("@timmo001/kestrel-server/Backups") {
  static readonly layer = Layer.effect(
    Backups,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const jobs = yield* Jobs;
      const sources = yield* Sources;
      const identity = yield* Identity;
      const restart = yield* Restart;
      const scope = yield* Effect.scope;

      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();

      const config = yield* configFolder;
      const state = yield* stateFolder;
      const ownRecordings = yield* ownRecordingsFolder;
      const folder = path.join(state, "backups");

      const busy = yield* Ref.make(false);

      const links = yield* Ref.make(
        new Map<
          string,
          { readonly request: BackupRequest; readonly expires: number }
        >(),
      );

      const at = Clock.currentTimeMillis.pipe(
        Effect.map((now) => new Date(now).toISOString()),
      );

      // A backup cut short last time leaves its part behind
      yield* Effect.forEach(
        yield* fs
          .readDirectory(folder)
          .pipe(Effect.orElseSucceed((): Array<string> => [])),
        (name) =>
          name.endsWith(".partial")
            ? fs.remove(path.join(folder, name)).pipe(Effect.ignore)
            : Effect.void,
      );

      const jobFor = (kind: "backup" | "restore"): Job => ({
        id: kind,
        kind,
        name: kind === "backup" ? "Make a backup" : "Restore a backup",
        state: "idle",
        detail: "",
        since: "",
      });

      const report = (kind: "backup" | "restore", change: (job: Job) => Job) =>
        jobs.update(kind, (job) => change(job ?? jobFor(kind)));

      /**
       * Marks a backup or restore as running, failing while another is;
       * the work it starts lets go with `release`.
       */
      const claim = (kind: "backup" | "restore", detail: string) =>
        Ref.getAndSet(busy, true).pipe(
          Effect.flatMap((running) =>
            running
              ? Effect.fail(
                  new BackupError({
                    message: "A backup or restore is already running",
                  }),
                )
              : report(kind, (job) => ({
                  ...job,
                  state: "running",
                  detail,
                  progress: undefined,
                })),
          ),
        );

      const release = Ref.set(busy, false);

      const finished = (kind: "backup" | "restore", summary: string) =>
        Effect.gen(function* () {
          const now = yield* at;

          yield* report(kind, (job) => ({
            ...job,
            state: "idle",
            detail: summary,
            lastRun: { at: now, summary },
          }));
        });

      const failed = (kind: "backup" | "restore", message: string) =>
        Effect.gen(function* () {
          const now = yield* at;

          yield* Effect.logWarning(message);
          yield* report(kind, (job) => ({
            ...job,
            state: "failed",
            detail: message,
            lastError: { at: now, message },
          }));
        });

      /** A file to go in a backup, read when its turn comes. */
      const entryFor = (
        planned: Contents.Planned,
        opened: Effect.Effect<void>,
      ): Tar.WriteEntry<BackupError, never> => ({
        path: planned.path,
        open: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          // Settings are small and may be written over at any time, so
          // they're read whole; a recording is held open, so one cleared
          // out part way still reads to its end
          if (!planned.path.startsWith("recordings/")) {
            const read = yield* fs.readFile(planned.file).pipe(Effect.option);

            if (Option.isNone(read)) return undefined;

            const info = yield* fs.stat(planned.file).pipe(Effect.option);

            yield* opened;

            return {
              size: read.value.length,
              modified: Option.match(
                Option.flatMap(info, (each) => each.mtime),
                { onNone: () => now, onSome: (date) => date.getTime() },
              ),
              data: Stream.make(read.value),
            };
          }

          const file = yield* fs.open(planned.file).pipe(Effect.option);

          if (Option.isNone(file)) return undefined;

          const info = yield* file.value.stat;
          const size = Number(info.size);
          let left = size;

          yield* opened;

          return {
            size,
            modified: Option.match(info.mtime, {
              onNone: () => now,
              onSome: (date) => date.getTime(),
            }),
            data: Stream.fromPull(
              Effect.succeed(
                Effect.gen(function* () {
                  if (left <= 0) return yield* Cause.done();

                  const chunk = yield* file.value
                    .readAlloc(Math.min(left, chunkSize))
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new BackupError({
                            message: `${planned.path} couldn't be read: ${error.message}`,
                          }),
                      ),
                    );

                  if (Option.isNone(chunk)) return yield* Cause.done();

                  left -= chunk.value.length;

                  const one: Arr.NonEmptyReadonlyArray<Uint8Array> = [
                    chunk.value,
                  ];

                  return one;
                }),
              ),
            ),
          };
        }).pipe(
          Effect.mapError(
            (error) =>
              new BackupError({
                message: `${planned.path} couldn't be read: ${error.message}`,
              }),
          ),
        ),
      });

      /**
       * A backup made as `request` asks, as a stream, telling `progress`
       * after each file opens.
       */
      const archive = (
        request: BackupRequest,
        progress: (
          files: number,
          total: number,
          bytes: number,
        ) => Effect.Effect<void> = () => Effect.void,
      ) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const settings = yield* sources.settings;

            const planned = yield* Contents.plan(
              {
                config,
                state,
                recordings: settings.recording.folder ?? ownRecordings,
              },
              request,
            );

            const manifest = Contents.manifestFor({
              server: identity.name,
              created: yield* at,
              request,
              planned,
            });

            let files = 0;
            let bytes = 0;

            const entries = [
              Tar.fromBytes(
                Contents.manifestPath,
                new TextEncoder().encode(encodeManifest(manifest)),
              ),
              ...planned.map((each) =>
                entryFor(
                  each,
                  Effect.suspend(() => {
                    files += 1;
                    bytes += each.bytes;

                    return progress(files, planned.length, bytes);
                  }),
                ),
              ),
            ];

            const tar = Tar.write(Stream.fromIterable(entries));

            return request.passphrase === undefined
              ? tar
              : Lock.lock(tar, request.passphrase);
          }),
        ).pipe(
          Stream.mapError((error) =>
            error instanceof BackupError
              ? error
              : new BackupError({
                  message: `The backup couldn't be made: ${error.message}`,
                }),
          ),
          Stream.provideContext(context),
        );

      const nameFor = Effect.gen(function* () {
        const stamp = (yield* at).replace(/\.\d+Z$/, "").replaceAll(":", "-");

        for (let count = 1; ; count++) {
          const name = `kestrel-${stamp}${count === 1 ? "" : `-${count}`}${extension}`;

          if (!(yield* fs.exists(path.join(folder, name)))) return name;
        }
      }).pipe(Effect.orDie);

      const fileOf = (name: string) =>
        Effect.gen(function* () {
          const file = path.join(folder, name);

          if (
            !namePattern.test(name) ||
            !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
          ) {
            return yield* new UnknownBackup({
              message: `There's no backup called ${name}`,
            });
          }

          return file;
        });

      const size = (bytes: number) =>
        bytes < 1024 * 1024
          ? `${Math.ceil(bytes / 1024)} KB`
          : bytes < 1024 ** 3
            ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
            : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

      const list = Effect.gen(function* () {
        const names = (yield* fs
          .readDirectory(folder)
          .pipe(Effect.orElseSucceed((): Array<string> => []))).filter((name) =>
          namePattern.test(name),
        );

        const found = yield* Effect.forEach(
          names,
          (name) =>
            Effect.gen(function* () {
              const file = path.join(folder, name);
              const info = yield* fs.stat(file);

              const start = yield* Effect.scoped(
                fs
                  .open(file)
                  .pipe(
                    Effect.flatMap((handle) =>
                      handle.readAlloc(Lock.startLength),
                    ),
                  ),
              );

              return Option.some<BackupFile>({
                name,
                bytes: Number(info.size),
                modified: Option.match(info.mtime, {
                  onNone: () => "",
                  onSome: (date) => date.toISOString(),
                }),
                locked: Option.exists(start, Lock.isLocked),
              });
            }).pipe(Effect.orElseSucceed(() => Option.none<BackupFile>())),
          { concurrency: 8 },
        );

        return found
          .flatMap(Option.toArray)
          .toSorted((a, b) => b.modified.localeCompare(a.modified));
      });

      const create = (request: BackupRequest) =>
        Effect.gen(function* () {
          const name = yield* nameFor;
          const file = path.join(folder, name);
          const partial = `${file}.partial`;

          const work = Effect.gen(function* () {
            yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
            yield* Stream.run(
              archive(request, (files, total, bytes) =>
                report("backup", (job) => ({
                  ...job,
                  detail: `Writing ${name}`,
                  progress: { done: files, total, bytes },
                })),
              ),
              fs.sink(partial, { mode: 0o600 }),
            );
            yield* fs.rename(partial, file);

            const info = yield* fs.stat(file);

            yield* finished(
              "backup",
              `Made ${name}, ${size(Number(info.size))}`,
            );
          }).pipe(
            Effect.catch((error) =>
              fs
                .remove(partial, { force: true })
                .pipe(
                  Effect.ignore,
                  Effect.andThen(
                    failed("backup", `The backup failed: ${error.message}`),
                  ),
                ),
            ),
            Effect.onInterrupt(() =>
              fs.remove(partial, { force: true }).pipe(Effect.ignore),
            ),
          );

          yield* claim("backup", `Writing ${name}`);
          yield* work.pipe(Effect.ensuring(release), Effect.forkIn(scope));

          return name;
        });

      const link = (request: BackupRequest) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const code = randomBytes(18).toString("base64url");

          yield* Ref.update(links, (current) => {
            const next = new Map(
              [...current].filter(([, each]) => each.expires > now),
            );

            next.set(code, { request, expires: now + linkLife });

            return next;
          });

          return code;
        });

      const download = (code: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const found = yield* Ref.modify(links, (current) => {
            const next = new Map(current);

            next.delete(code);

            return [current.get(code), next] as const;
          });

          if (found === undefined || found.expires <= now) {
            return yield* new UnknownBackup({
              message: "That download link is used or has run out",
            });
          }

          return {
            name: yield* nameFor,
            data: archive(found.request),
          };
        });

      const file = (name: string) =>
        fileOf(name).pipe(
          Effect.map((found): Download => ({
            name,
            data: fs
              .stream(found)
              .pipe(
                Stream.mapError(
                  (error) => new BackupError({ message: error.message }),
                ),
              ),
          })),
        );

      const remove = (name: string) =>
        fileOf(name).pipe(
          Effect.flatMap((found) =>
            fs
              .remove(found)
              .pipe(
                Effect.mapError(
                  (error) => new UnknownBackup({ message: error.message }),
                ),
              ),
          ),
        );

      /** Stages a backup, then restarts the server to put it in place. */
      const stage = <E extends { readonly message: string }>(
        data: Stream.Stream<Uint8Array, E>,
        options: RestoreOptions,
      ) =>
        Restore.stage(data, {
          recordings: options.recordings,
          passphrase: options.passphrase,
          progress: (files, total, bytes) =>
            report("restore", (job) => ({
              ...job,
              detail: "Reading the backup",
              progress: { done: files, total, bytes },
            })),
        }).pipe(
          Effect.tap((manifest) =>
            finished(
              "restore",
              `Read the backup of ${manifest.server} from ${manifest.created}; restarting to put it in place`,
            ),
          ),
          Effect.andThen(restart.request),
          Effect.tapError((error) => failed("restore", error.message)),
          Effect.provideContext(context),
        );

      const restore = (name: string, options: RestoreOptions) =>
        Effect.gen(function* () {
          const { data } = yield* file(name);

          // Checked first, so a wrong passphrase is told at once
          yield* Restore.manifestOf(data, options.passphrase).pipe(
            Effect.provideContext(context),
          );
          yield* claim("restore", `Reading ${name}`);
          yield* stage(data, options).pipe(
            Effect.ignore,
            Effect.ensuring(release),
            Effect.forkIn(scope),
          );
        });

      const upload = <E extends { readonly message: string }>(
        data: Stream.Stream<Uint8Array, E>,
        options: RestoreOptions,
      ) =>
        claim("restore", "Reading the uploaded backup").pipe(
          Effect.andThen(stage(data, options)),
          Effect.ensuring(release),
        );

      return Backups.of({
        list,
        create,
        link,
        download,
        file,
        remove,
        restore,
        upload,
      });
    }),
  );
}
