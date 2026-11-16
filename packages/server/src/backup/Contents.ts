/**
 * What a backup holds and where each part comes from and goes back to: a
 * manifest first, then `config/` for the sources file and the recorder's
 * saved login, `state/` for the server's own files, such as its id, paired
 * devices and push subscriptions, and `recordings/` for each camera's
 * folder as the recordings folder lays it out. This machine's own CLI and
 * desktop connections, and files the server makes again, such as go2rtc's
 * config, stay out.
 *
 * @module
 */
import { version } from "@timmo001/kestrel-core";
import * as Nvr from "@timmo001/kestrel-nvr";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import type { BackupRequest } from "../Api.ts";

/** The manifest's path, always the first in a backup. */
export const manifestPath = "kestrel-backup.json";

/** The files from the config folder a backup holds. */
export const configFiles = ["sources.json", "recorder.env"] as const;

/** The files from the state folder a backup holds. */
export const stateFiles = [
  "server.json",
  "devices.json",
  "owner.token",
  "push.json",
  "uploads.json",
  "activity.jsonl",
] as const;

/** What a backup says about itself. */
export const Manifest = Schema.Struct({
  format: Schema.Literal(1),
  /** The Kestrel that made it. */
  version: Schema.String,
  /** When, as an ISO time. */
  created: Schema.String,
  /** The server's name. */
  server: Schema.String,
  /** Which recordings went in. */
  recordings: Schema.Struct({
    included: Schema.Boolean,
    cameras: Schema.optional(Schema.Array(Schema.String)),
    from: Schema.optional(Schema.String),
    to: Schema.optional(Schema.String),
  }),
  /** The files after the manifest, and their bytes. */
  files: Schema.Number,
  bytes: Schema.Number,
});

export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}

export const manifestJson = Schema.fromJsonString(Manifest);

/** A file to go in a backup. */
export interface Planned {
  /** Its path in the backup, such as `recordings/swann/3/2026-11-13/14-02-33.mp4`. */
  readonly path: string;
  /** Where it is now. */
  readonly file: string;
  readonly bytes: number;
}

/** Where a backup's file goes back to. */
export interface Placed {
  readonly area: "config" | "state" | "recordings";
  /** Its path inside that area's folder, a part at a time. */
  readonly parts: ReadonlyArray<string>;
}

const isConfigFile = (name: string) =>
  configFiles.some((each) => each === name);

const isStateFile = (name: string) => stateFiles.some((each) => each === name);

/**
 * Where a path in a backup goes, or nothing for one a backup doesn't hold,
 * which is passed over. Only names the server makes itself get through, so
 * nothing in a backup can reach outside its folders.
 */
export const place = (entry: string): Placed | undefined => {
  const parts = entry.split("/");
  const [area, ...rest] = parts;
  const name = rest.at(-1);

  if (name === undefined) return undefined;

  if (area === "config" && rest.length === 1 && isConfigFile(name)) {
    return { area, parts: rest };
  }

  if (area === "state" && rest.length === 1 && isStateFile(name)) {
    return { area, parts: rest };
  }

  if (area !== "recordings") return undefined;

  if (name === Nvr.marker) {
    return Nvr.isKey(rest.slice(0, -1).join("/"))
      ? { area, parts: rest }
      : undefined;
  }

  const day = rest.at(-2);

  return day !== undefined &&
    Nvr.dayPattern.test(day) &&
    (Nvr.filePattern.test(name) || name === Nvr.lengthsFile) &&
    Nvr.isKey(rest.slice(0, -2).join("/"))
    ? { area, parts: rest }
    : undefined;
};

/** A file's size, or nothing when it isn't a file there. */
const sizeOf = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.stat(file).pipe(
      Effect.map((info) =>
        info.type === "File" ? Option.some(Number(info.size)) : Option.none(),
      ),
      Effect.orElseSucceed(() => Option.none<number>()),
    );
  });

const namesIn = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
  });

export interface Folders {
  readonly config: string;
  readonly state: string;
  readonly recordings: string;
}

/** Every file a backup of `folders` takes, as `request` asks. */
export const plan = Effect.fnUntraced(function* (
  folders: Folders,
  request: BackupRequest,
) {
  const path = yield* Path.Path;

  const from = (
    area: "config" | "state",
    folder: string,
    names: ReadonlyArray<string>,
  ) =>
    Effect.forEach(names, (name) => {
      const file = path.join(folder, name);

      return sizeOf(file).pipe(
        Effect.map(
          Option.map((bytes): Planned => ({
            path: `${area}/${name}`,
            file,
            bytes,
          })),
        ),
      );
    });

  const settings = [
    ...(yield* from("config", folders.config, configFiles)),
    ...(yield* from("state", folders.state, stateFiles)),
  ].flatMap(Option.toArray);

  if (request.recordings === false) return settings;

  const wanted = (key: string) =>
    request.cameras === undefined || request.cameras.includes(key);

  const inRange = (date: string) =>
    (request.from === undefined || date >= request.from) &&
    (request.to === undefined || date <= request.to);

  const keys = (yield* Nvr.Library.cameras(folders.recordings)).filter(wanted);

  const recordings = yield* Effect.forEach(
    keys.toSorted(),
    (key) =>
      Effect.gen(function* () {
        const camera = path.join(folders.recordings, ...key.split("/"));

        const dates = (yield* namesIn(camera))
          .filter((name) => Nvr.dayPattern.test(name) && inRange(name))
          .toSorted();

        const files = yield* Effect.forEach(
          dates,
          (date) =>
            namesIn(path.join(camera, date)).pipe(
              Effect.map((names) =>
                names
                  .filter(
                    (name) =>
                      Nvr.filePattern.test(name) || name === Nvr.lengthsFile,
                  )
                  .toSorted()
                  .map((name) => ({
                    path: `recordings/${key}/${date}/${name}`,
                    file: path.join(camera, date, name),
                  })),
              ),
            ),
          { concurrency: 4 },
        );

        // The marker goes first, so a restore knows the folder for a camera's
        const marked = [
          {
            path: `recordings/${key}/${Nvr.marker}`,
            file: path.join(camera, Nvr.marker),
          },
          ...files.flat(),
        ];

        const sized = yield* Effect.forEach(
          marked,
          (each) =>
            sizeOf(each.file).pipe(
              Effect.map(Option.map((bytes): Planned => ({ ...each, bytes }))),
            ),
          { concurrency: 16 },
        );

        return sized.flatMap(Option.toArray);
      }),
    { concurrency: 2 },
  );

  return [...settings, ...recordings.flat()];
});

/** The manifest for `planned`. */
export const manifestFor = (options: {
  readonly server: string;
  readonly created: string;
  readonly request: BackupRequest;
  readonly planned: ReadonlyArray<Planned>;
}): Manifest => ({
  format: 1,
  version,
  created: options.created,
  server: options.server,
  recordings: {
    included: options.request.recordings !== false,
    cameras: options.request.cameras,
    from: options.request.from,
    to: options.request.to,
  },
  files: options.planned.length,
  bytes: options.planned.reduce((sum, each) => sum + each.bytes, 0),
});
