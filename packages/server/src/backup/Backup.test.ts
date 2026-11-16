/**
 * Checks the ways a backup could go quietly wrong: a locked one that opens
 * with the wrong passphrase or with parts cut off, a path in one that
 * reaches outside Kestrel's folders, and a restore that loses or mixes up
 * recordings when merging or replacing, or puts them in a folder that isn't
 * on this machine.
 */
import { BunServices } from "@effect/platform-bun";
import * as Tar from "@timmo001/kestrel-format-tar";
import * as Nvr from "@timmo001/kestrel-nvr";
import { expect, test } from "bun:test";
import {
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { BackupError } from "../Api.ts";
import { manifestJson, manifestPath, place } from "./Contents.ts";
import * as Lock from "./Lock.ts";
import * as Restore from "./Restore.ts";

const runPromise = <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => program.pipe(Effect.provide(BunServices.layer), Effect.runPromise);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => Buffer.concat([...chunks])),
  );

/** Splits bytes into uneven chunks, as a network hands them on. */
const chunked = (bytes: Uint8Array) =>
  Stream.fromIterable(
    Array.from({ length: Math.ceil(bytes.length / 70_001) }, (_, index) =>
      bytes.subarray(index * 70_001, (index + 1) * 70_001),
    ),
  );

test("a locked backup opens with its passphrase, across parts, and not otherwise", async () => {
  // Over two parts, so a part's number and the last part's mark both count
  const plain = new Uint8Array(2.5 * 1024 * 1024).map(
    (_, index) => index % 251,
  );

  const locked = await runPromise(
    collect(Lock.lock(chunked(plain), "correct horse")),
  );

  expect(Lock.isLocked(locked)).toBe(true);
  expect(locked.includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);

  const opened = await runPromise(
    collect(Lock.unlock(chunked(locked), "correct horse")),
  );

  expect(Buffer.compare(opened, plain)).toBe(0);

  const wrong = await runPromise(
    Effect.exit(collect(Lock.unlock(chunked(locked), "wrong horse"))),
  );

  expect(Exit.isFailure(wrong)).toBe(true);

  const none = await runPromise(
    Effect.flip(collect(Lock.unlock(chunked(locked), undefined))),
  );

  expect(none).toBeInstanceOf(BackupError);

  // Cut after the first part: what's left must not pass for the whole
  const firstPart = 8 + 1 + 16 + 12 + 4 + 1024 * 1024 + 16;

  const cut = await runPromise(
    Effect.exit(
      collect(
        Lock.unlock(chunked(locked.subarray(0, firstPart)), "correct horse"),
      ),
    ),
  );

  expect(Exit.isFailure(cut)).toBe(true);

  // Without a passphrase, a backup is the archive as it is
  const open = await runPromise(
    collect(Lock.unlock(chunked(plain), undefined)),
  );

  expect(Buffer.compare(open, plain)).toBe(0);
});

test("only the files a backup holds are put back, inside their folders", () => {
  expect(place("config/sources.json")).toEqual({
    area: "config",
    parts: ["sources.json"],
  });
  expect(place("state/devices.json")?.area).toBe("state");
  expect(place("recordings/swann/3/.kestrel-recordings")?.parts).toEqual([
    "swann",
    "3",
    ".kestrel-recordings",
  ]);
  expect(
    place("recordings/swann/3/2026-11-13/14-02-33.motion.mp4"),
  ).toBeDefined();
  expect(
    place("recordings/swann/3/2026-11-13/.kestrel-lengths.json"),
  ).toBeDefined();

  for (const outside of [
    "config/client.json",
    "config/../sources.json",
    "state/../../.bashrc",
    "state/sub/devices.json",
    "recordings/../../etc/passwd",
    "recordings/../2026-11-13/14-02-33.mp4",
    "recordings/swann/../../2026-11-13/14-02-33.mp4",
    "recordings/swann/3/2026-11-13/evil.sh",
    "recordings/swann/3/not-a-day/14-02-33.mp4",
    "recordings/2026-11-13/14-02-33.mp4",
    "/etc/passwd",
    "kestrel-backup.json",
  ]) {
    expect(place(outside)).toBeUndefined();
  }
});

const encodeManifest = Schema.encodeSync(manifestJson);

/** A backup of `files`, by their paths in it, as `Backups` writes one. */
const backupOf = (files: Record<string, string>, modified: number) =>
  Tar.write(
    Stream.fromIterable([
      Tar.fromBytes(
        manifestPath,
        new TextEncoder().encode(
          encodeManifest({
            format: 1,
            version: "0.0.0",
            created: "2026-11-15T12:00:00.000Z",
            server: "test",
            recordings: { included: true },
            files: Object.keys(files).length,
            bytes: 0,
          }),
        ),
      ),
      ...Object.entries(files).map(([path, text]) =>
        Tar.fromBytes(path, new TextEncoder().encode(text), { modified }),
      ),
    ]),
  );

/** Runs `program` over new config, state and recordings folders. */
const inFolders = <A, E>(
  program: (folders: {
    readonly config: string;
    readonly state: string;
    readonly recordings: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "kestrel-backup-",
    });

    const folders = {
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      recordings: path.join(root, "state", "recordings"),
    };

    return yield* program(folders).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KESTREL_CONFIG: folders.config,
            KESTREL_STATE: folders.state,
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const write = (file: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  });

const restoreBackup = (
  files: Record<string, string>,
  recordings: "merge" | "replace",
) =>
  Restore.stage(backupOf(files, Date.UTC(2026, 10, 13, 14, 3)), {
    recordings,
    progress: () => Effect.void,
  }).pipe(Effect.andThen(Restore.applyPending));

const day = "swann/3/2026-11-13";

test("a restore merges recordings beside the ones here, or replaces them", async () => {
  const backup = {
    "config/sources.json": "{}",
    "state/devices.json": '{"restored":true}',
    "recordings/swann/3/.kestrel-recordings": "",
    [`recordings/${day}/14-02-33.mp4`]: "from the backup",
    [`recordings/${day}/14-07-33.mp4`]: "only in the backup",
    [`recordings/${day}/.kestrel-lengths.json`]:
      '{"14-02-33.mp4":1,"14-07-33.mp4":2}',
  };

  const merged = await runPromise(
    inFolders((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const at = (...parts: Array<string>) =>
          path.join(folders.recordings, ...parts);

        yield* write(path.join(folders.state, "devices.json"), "{}");
        yield* write(at("swann", "3", Nvr.marker), "");
        yield* write(at(day, "14-02-33.mp4"), "already here");
        yield* write(at(day, "15-00-00.mp4"), "only here");
        yield* write(
          at(day, Nvr.lengthsFile),
          '{"14-02-33.mp4":9,"15-00-00.mp4":3}',
        );
        yield* write(at("front", "1", Nvr.marker), "");
        yield* write(at("front", "1", "2026-11-12", "09-00-00.mp4"), "front");

        yield* restoreBackup(backup, "merge");

        return {
          devices: yield* fs.readFileString(
            path.join(folders.state, "devices.json"),
          ),
          same: yield* fs.readFileString(at(day, "14-02-33.mp4")),
          added: yield* fs.readFileString(at(day, "14-07-33.mp4")),
          kept: yield* fs.readFileString(at(day, "15-00-00.mp4")),
          front: yield* fs.exists(
            at("front", "1", "2026-11-12", "09-00-00.mp4"),
          ),
          lengths: JSON.parse(
            yield* fs.readFileString(at(day, Nvr.lengthsFile)),
          ),
          modified: (yield* fs.stat(at(day, "14-07-33.mp4"))).mtime,
          staged: yield* fs.exists(path.join(folders.state, "restore")),
        };
      }),
    ),
  );

  expect(merged.devices).toBe('{"restored":true}');
  expect(merged.same).toBe("already here");
  expect(merged.added).toBe("only in the backup");
  expect(merged.kept).toBe("only here");
  expect(merged.front).toBe(true);
  expect(merged.lengths).toEqual({
    "14-02-33.mp4": 9,
    "14-07-33.mp4": 2,
    "15-00-00.mp4": 3,
  });
  // The library tells how long a recording ran from when it last changed
  expect(Option.getOrUndefined(merged.modified)?.getTime()).toBe(
    Date.UTC(2026, 10, 13, 14, 3),
  );
  expect(merged.staged).toBe(false);

  const replaced = await runPromise(
    inFolders((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const at = (...parts: Array<string>) =>
          path.join(folders.recordings, ...parts);

        yield* write(at("swann", "3", Nvr.marker), "");
        yield* write(at(day, "15-00-00.mp4"), "only here");
        yield* write(at("front", "1", Nvr.marker), "");
        yield* write(at("front", "1", "2026-11-12", "09-00-00.mp4"), "front");
        yield* write(at("not-kestrels", "keep.txt"), "someone else's");

        yield* restoreBackup(backup, "replace");

        return {
          restored: yield* fs.readFileString(at(day, "14-02-33.mp4")),
          gone: yield* fs.exists(at(day, "15-00-00.mp4")),
          front: yield* fs.exists(at("front", "1")),
          other: yield* fs.exists(at("not-kestrels", "keep.txt")),
        };
      }),
    ),
  );

  expect(replaced).toEqual({
    restored: "from the backup",
    gone: false,
    front: false,
    other: true,
  });
});

test("a backup's recordings folder that isn't on this machine is left to this server", async () => {
  const result = await runPromise(
    inFolders((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* restoreBackup(
          {
            "config/sources.json": JSON.stringify({
              sources: [],
              cameras: [],
              recording: { folder: path.join(folders.state, "elsewhere") },
            }),
            "recordings/swann/3/.kestrel-recordings": "",
            [`recordings/${day}/14-02-33.mp4`]: "from the backup",
          },
          "merge",
        );

        const settings = JSON.parse(
          yield* fs.readFileString(path.join(folders.config, "sources.json")),
        );

        return {
          folder: settings.recording.folder,
          recording: yield* fs.readFileString(
            path.join(folders.recordings, day, "14-02-33.mp4"),
          ),
        };
      }),
    ),
  );

  expect(result).toEqual({ folder: null, recording: "from the backup" });
});

test("a backup that fails part way changes nothing", async () => {
  const result = await runPromise(
    inFolders((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* write(path.join(folders.state, "devices.json"), "{}");

        const whole = yield* collect(
          backupOf({ "state/devices.json": '{"restored":true}' }, 0),
        );

        const failed = yield* Restore.stage(
          Stream.make(whole.subarray(0, 1100)),
          { recordings: "merge", progress: () => Effect.void },
        ).pipe(Effect.flip);

        yield* Restore.applyPending;

        return {
          failed,
          devices: yield* fs.readFileString(
            path.join(folders.state, "devices.json"),
          ),
          left: yield* fs.readDirectory(folders.state),
        };
      }),
    ),
  );

  expect(result.failed).toBeInstanceOf(BackupError);
  expect(result.devices).toBe("{}");
  expect(result.left).toEqual(["devices.json"]);
});
