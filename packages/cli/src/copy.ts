/**
 * `kestrel config copy`: sends this machine's sources to another server, so
 * a server on a Home Assistant box or in a container takes the same setup
 * without SSH or Docker. It reads `sources.json` from the config folder,
 * secrets and all, fills each field it leaves empty from the environment or
 * `recorder.env` beside it (`KESTREL_<KIND>_<FIELD>`, such as
 * `KESTREL_RAYSHARP_HOST`), and saves them on the other server through its
 * API. The recordings folder is left to the other server, since it's a path
 * on this machine. Nothing it reads is printed.
 *
 * @module
 */
import { parseEnv } from "node:util";
import {
  Settings,
  type KindInfo,
  type SourceSettings,
} from "@timmo001/kestrel-core";
import { configFolder } from "@timmo001/kestrel-server/folders";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ClientError } from "./operations.ts";

const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Settings),
);

/** A field's environment variable, such as `KESTREL_RAYSHARP_RTSP_PORT` for a `raysharp` source's `rtspPort`. */
export const environmentName = (kind: string, key: string) =>
  `KESTREL_${kind}_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase();

/** The environment, with `recorder.env` in the config folder under it. */
const environment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const saved = yield* fs
    .readFileString(path.join(yield* configFolder, "recorder.env"))
    .pipe(Effect.orElseSucceed(() => ""));

  return { ...parseEnv(saved), ...process.env };
});

/** A source's settings with each field it leaves empty taken from the environment, where it's there. */
export const filledIn = (
  source: SourceSettings,
  kind: KindInfo | undefined,
  env: Readonly<Record<string, string | undefined>>,
): SourceSettings => ({
  id: source.id,
  kind: source.kind,
  name: source.name,
  enabled: source.enabled,
  settings: Object.fromEntries([
    ...Object.entries(source.settings),
    ...(kind?.fields ?? []).flatMap((field) => {
      const value = source.settings[field.key];
      const given = env[environmentName(source.kind, field.key)];

      return (value === undefined || value === "") && given !== undefined
        ? [[field.key, field.type === "number" ? Number(given) : given]]
        : [];
    }),
  ]),
  cameras: source.cameras,
  secrets: [],
});

/** This machine's sources, filled in from its environment, ready to save on another server. */
export const localSettings = Effect.fn("localSettings")(function* (
  kinds: ReadonlyArray<KindInfo>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(yield* configFolder, "sources.json");

  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError(
      () =>
        new ClientError({
          message: `There's no ${file} to copy: set the sources up on this machine's Settings page first`,
        }),
    ),
  );

  const settings = yield* decodeSettings(text).pipe(
    Effect.mapError(
      (error) =>
        new ClientError({ message: `${file} can't be read: ${error.message}` }),
    ),
  );

  const env = yield* environment;

  return {
    sources: settings.sources.map((source) =>
      filledIn(
        source,
        kinds.find((kind) => kind.kind === source.kind),
        env,
      ),
    ),
    cameras: settings.cameras,
    order: settings.order,
    off: settings.off,
    recording: { ...settings.recording, folder: null },
  };
});
