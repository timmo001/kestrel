/**
 * Updating the app to a server's version, so the two match again. On
 * Windows the app installs itself, so it downloads that release's Setup,
 * checks it against the release's SHA256SUMS, unpacks it beside its own
 * files and starts it, then the app quits so the Setup can replace it.
 * Elsewhere a package manager owns the app, so it opens the release and says
 * how to update.
 */
import { createHash } from "node:crypto";

import { updateSteps } from "@timmo001/kestrel-core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Whether the app updates itself here, rather than through a package manager. */
export const updatesItself = process.platform === "win32";

/** A release's page. */
export const releasePage = (version: string) =>
  `https://github.com/timmo001/kestrel/releases/tag/${version}`;

/** How to update the app where it doesn't update itself. */
export const updateHelp = `Update Kestrel: ${updateSteps.client}`;

/** The update couldn't be downloaded, checked or started. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()(
  "UpdateFailed",
  { message: Schema.String },
) {}

const download = Effect.fn("download")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;

  return yield* http.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (error) =>
        new UpdateFailed({
          message: `Couldn't download ${url}: ${error.message}`,
        }),
    ),
  );
});

/**
 * Downloads, checks and starts the Windows Setup for `version`. The app
 * quits once this succeeds.
 */
export const installVersion = Effect.fn("installVersion")(
  function* (version: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const release = `https://github.com/timmo001/kestrel/releases/download/${version}`;
    const name = `Kestrel-Setup-${version}-windows-x86_64.zip`;
    const archive = yield* download(`${release}/${name}`);

    const sums = new TextDecoder().decode(
      yield* download(`${release}/SHA256SUMS`),
    );

    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, file]) => file === name)?.[0];

    const actual = createHash("sha256").update(archive).digest("hex");

    if (expected === undefined || expected !== actual) {
      return yield* new UpdateFailed({
        message: `${name} doesn't match the release's SHA256SUMS, so it wasn't run`,
      });
    }

    const folder = yield* fs.makeTempDirectory({ prefix: "kestrel-update-" });
    const file = path.join(folder, name);

    yield* fs.writeFile(file, archive);

    // Windows' own tar unpacks zips; the Setup reads the .installer folder
    // beside it
    const unpacked = yield* spawner
      .spawn(
        ChildProcess.make("tar", ["-xf", file, "-C", folder], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.flatMap((handle) => handle.exitCode),
        Effect.scoped,
      );

    if (unpacked !== 0) {
      return yield* new UpdateFailed({
        message: `Couldn't unpack ${name}: tar exited with code ${unpacked}`,
      });
    }

    // Detached and let go of, so it carries on once the app quits
    yield* spawner
      .spawn(
        ChildProcess.make(path.join(folder, "Kestrel-Setup.exe"), [], {
          cwd: folder,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.flatMap((handle) => handle.unref),
        Effect.scoped,
      );
  },
  Effect.mapError((error) =>
    error instanceof UpdateFailed
      ? error
      : new UpdateFailed({ message: error.message }),
  ),
);
