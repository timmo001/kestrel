/**
 * Checks an archive reads back as it was written however its bytes arrive,
 * with long paths and empty files, that GNU or BSD tar reads what's written
 * and the other way round, and that a cut-off archive fails rather than
 * reading as a shorter one.
 */
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fromBytes, read, TarError, write } from "./index.ts";

const text = new TextEncoder();

/** Bytes cut into chunks of `size`, as a network or file might hand them on. */
const rechunked = (bytes: Uint8Array, size: number) =>
  Stream.fromIterable(
    Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) =>
      bytes.subarray(index * size, (index + 1) * size),
    ),
  );

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

/** Every file in an archive, by path. */
const readAll = (source: Stream.Stream<Uint8Array, unknown>) =>
  Effect.gen(function* () {
    const files = new Map<string, string>();

    yield* read(source, (entry) =>
      collect(entry.data).pipe(
        Effect.map((data) => {
          files.set(entry.path, data.toString());
        }),
      ),
    );

    return files;
  });

const longPath = `recordings/${"front-garden-".repeat(12)}cam/1/2026-11-12/14-02-33.motion.mp4`;

const files = new Map([
  ["manifest.json", JSON.stringify({ version: 1 })],
  ["empty.txt", ""],
  [longPath, "x".repeat(70_000)],
  ["state/devices.json", "{}"],
]);

const archive = () =>
  collect(
    write(
      Stream.fromIterable(
        [...files].map(([path, body]) => fromBytes(path, text.encode(body))),
      ),
    ),
  ).pipe(Effect.runPromise);

test("an archive reads back as it was written, however its bytes are chunked", async () => {
  const bytes = await archive();

  for (const size of [1, 7, 512, 513, 65_536, bytes.length]) {
    const read = await readAll(rechunked(bytes, size)).pipe(Effect.runPromise);

    expect(read).toEqual(files);
  }
});

test("a file a reader leaves alone is skipped", async () => {
  const bytes = await archive();
  const seen: Array<string> = [];

  await read(rechunked(bytes, 100), (entry) =>
    Effect.sync(() => {
      seen.push(entry.path);
    }),
  ).pipe(Effect.runPromise);

  expect(seen).toEqual([...files.keys()]);
});

test("a cut-off archive fails", async () => {
  const bytes = await archive();

  const error = await readAll(rechunked(bytes.subarray(0, 3000), 512)).pipe(
    Effect.flip,
    Effect.runPromise,
  );

  expect(error).toBeInstanceOf(TarError);
});

test("tar reads what's written, and what tar writes reads back", async () => {
  if (Bun.which("tar") === null) return;

  const listed = await Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const folder = yield* fs.makeTempDirectoryScoped({
      prefix: "kestrel-tar-",
    });

    const file = path.join(folder, "ours.tar");

    const tar = (args: Array<string>) =>
      spawner.exitCode(ChildProcess.make("tar", args)).pipe(Effect.map(Number));

    yield* fs.writeFile(file, yield* Effect.promise(archive));

    const out = path.join(folder, "out");

    yield* fs.makeDirectory(out);

    expect(yield* tar(["-xf", file, "-C", out])).toBe(0);
    expect(yield* fs.readFileString(path.join(out, longPath))).toBe(
      files.get(longPath) ?? "",
    );

    const theirs = path.join(folder, "theirs.tar");

    expect(yield* tar(["-cf", theirs, "-C", out, "."])).toBe(0);

    return yield* readAll(fs.stream(theirs));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

  const sorted = (map: Map<string, string>) =>
    new Map([...map].toSorted(([a], [b]) => a.localeCompare(b)));

  expect(sorted(listed)).toEqual(sorted(files));
});
