/**
 * The sources file, `sources.json` in the config folder: every source's
 * settings and the labels you gave cameras. It holds logins, so only your
 * account can read it, and they never leave the server: what the API reads
 * back leaves secrets out, saying which are set, and hides any password in
 * an address, and a save keeps each one it didn't change.
 *
 * @module
 */
import {
  CameraKey,
  InvalidSettings,
  Settings,
  hiddenPassword,
  hidePassword,
  type KindInfo,
  type SettingField,
  type SettingValues,
  type SourceSettings,
} from "@timmo001/kestrel-core";
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Predicate, Schema } from "effect";

export const fileName = "sources.json";

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(Settings));

const isCameraKey = Schema.is(CameraKey);

/** The settings a field list doesn't hide, with any password in an address hidden. */
const shownValues = (
  fields: ReadonlyArray<SettingField>,
  values: SettingValues,
): SettingValues =>
  Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const field = fields.find((each) => each.key === key);

      if (field?.type === "secret") return [];

      return [
        [
          key,
          field?.type === "address" && Predicate.isString(value)
            ? hidePassword(value)
            : value,
        ],
      ];
    }),
  );

/** An address's hidden password put back from the one saved before. */
const restorePassword = (address: string, saved: string) => {
  try {
    const url = new URL(address);

    if (url.password !== hiddenPassword) return address;

    url.password = new URL(saved).password;

    return url.href;
  } catch {
    return address;
  }
};

/** Settings as sent from the page, with each secret it left out and each hidden password put back. */
const restoredValues = (
  fields: ReadonlyArray<SettingField>,
  values: SettingValues,
  saved: SettingValues | undefined,
): SettingValues =>
  Object.fromEntries([
    ...Object.entries(values).map(([key, value]) => {
      const field = fields.find((each) => each.key === key);
      const before = saved?.[key];

      return [
        key,
        field?.type === "address" &&
        Predicate.isString(value) &&
        Predicate.isString(before)
          ? restorePassword(value, before)
          : value,
      ];
    }),
    ...fields.flatMap((field) => {
      const before = saved?.[field.key];

      return field.type === "secret" &&
        !(field.key in values) &&
        before !== undefined
        ? [[field.key, before]]
        : [];
    }),
  ]);

/** Settings as the file keeps them, without which secrets are set, which is only read back. */
const forFile = (settings: Settings) => ({
  sources: settings.sources.map((source) => ({
    id: source.id,
    kind: source.kind,
    name: source.name,
    // Only an off source says so, as JSON leaves undefined out, so the files of sources left on stay as they were
    enabled: source.enabled ? undefined : false,
    settings: source.settings,
    cameras: source.cameras,
  })),
  cameras: settings.cameras,
  order: settings.order,
  // Only when a camera's off, so files with none off stay as they were
  off: settings.off.length === 0 ? undefined : settings.off,
  recording: settings.recording,
});

/** Which version of the settings these are: a hash of them as the file keeps them. */
export const revisionOf = (settings: Settings) =>
  createHash("sha256")
    .update(JSON.stringify(forFile(settings)))
    .digest("hex")
    .slice(0, 16);

/** The settings as the API reads them back: secrets left out, and which are set. */
export const shown = (
  kinds: ReadonlyArray<KindInfo>,
  settings: Settings,
): Settings => ({
  sources: settings.sources.map((source): SourceSettings => {
    const kind = kinds.find((each) => each.kind === source.kind);
    const fields = kind?.fields ?? [];
    const cameraFields = kind?.cameraFields ?? [];

    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      enabled: source.enabled,
      settings: shownValues(fields, source.settings),
      cameras: source.cameras.map((camera) =>
        shownValues(cameraFields, camera),
      ),
      secrets: fields.flatMap((field) => {
        const value = source.settings[field.key];

        return field.type === "secret" && value !== undefined && value !== ""
          ? [field.key]
          : [];
      }),
    };
  }),
  cameras: settings.cameras,
  order: settings.order,
  off: settings.off,
  recording: settings.recording,
  revision: revisionOf(settings),
});

/**
 * Settings sent from the page, with what it couldn't see put back from the
 * saved ones: each secret it left out, and each hidden password. A source is
 * matched by its id and kind, and its cameras by their `id`.
 */
export const restored = (
  kinds: ReadonlyArray<KindInfo>,
  incoming: Settings,
  saved: Settings,
): Settings => ({
  sources: incoming.sources.map((source): SourceSettings => {
    const kind = kinds.find((each) => each.kind === source.kind);

    const before = saved.sources.find(
      (each) => each.id === source.id && each.kind === source.kind,
    );

    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      enabled: source.enabled,
      settings: restoredValues(
        kind?.fields ?? [],
        source.settings,
        before?.settings,
      ),
      cameras: source.cameras.map((camera) =>
        restoredValues(
          kind?.cameraFields ?? [],
          camera,
          before?.cameras.find((each) => each["id"] === camera["id"]),
        ),
      ),
      secrets: [],
    };
  }),
  cameras: incoming.cameras.flatMap((camera) =>
    camera.label.trim() === ""
      ? []
      : [{ camera: camera.camera, label: camera.label.trim() }],
  ),
  order: incoming.order.filter(
    (camera, index) => incoming.order.indexOf(camera) === index,
  ),
  off: incoming.off.filter(
    (camera, index) => incoming.off.indexOf(camera) === index,
  ),
  recording: {
    cameras: incoming.recording.cameras.filter(
      (camera, index) => incoming.recording.cameras.indexOf(camera) === index,
    ),
    folder: incoming.recording.folder?.trim() || null,
    continuousHours: incoming.recording.continuousHours,
    clipHours: incoming.recording.clipHours,
    diskShare: incoming.recording.diskShare,
    limits: incoming.recording.limits,
  },
});

/** The required fields a set of values leaves out or empty. */
const missing = (fields: ReadonlyArray<SettingField>, values: SettingValues) =>
  fields.flatMap((field) => {
    const value = values[field.key];

    return field.required && (value === undefined || value === "")
      ? [field.label]
      : [];
  });

/**
 * What's wrong with settings before they're saved: two sources with one id,
 * a kind the server doesn't know, a required field left empty, or a camera
 * without an id of its own.
 */
export const problems = (
  kinds: ReadonlyArray<KindInfo>,
  settings: Settings,
): Array<string> =>
  settings.sources.flatMap((source, index) => {
    const kind = kinds.find((each) => each.kind === source.kind);

    if (kind === undefined) {
      return [
        `${source.name}: there's no kind of source called ${source.kind}`,
      ];
    }

    const repeated = settings.sources
      .slice(0, index)
      .some((each) => each.id === source.id);

    const cameras = source.cameras;
    const cameraFields = kind.cameraFields ?? [];

    const cameraIds = cameras.map((camera) => camera["id"]);

    return [
      ...(source.name.trim() === "" ? [`${source.id} needs a name`] : []),
      ...(repeated ? [`More than one source has the id ${source.id}`] : []),
      ...missing(kind.fields, source.settings).map(
        (label) => `${source.name} needs its ${label}`,
      ),
      ...(kind.cameraFields !== null && cameras.length === 0
        ? [`${source.name} needs a camera`]
        : []),
      ...cameras.flatMap((camera, at) => {
        const id = camera["id"];

        const own =
          Predicate.isString(id) && isCameraKey(id)
            ? cameraIds.indexOf(id) === at
              ? []
              : [`${source.name} has more than one camera ${id}`]
            : [
                `${source.name}: camera ${at + 1} needs an id of lower-case letters, digits and dashes`,
              ];

        return [
          ...own,
          ...missing(cameraFields, camera).map(
            (label) => `${source.name}: camera ${at + 1} needs its ${label}`,
          ),
        ];
      }),
    ];
  });

/** The sources file in `folder`, if there is one. */
export const read = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(folder, fileName);

  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
    return undefined;
  }

  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeFile),
    Effect.mapError(
      (error) =>
        new InvalidSettings({
          message: `${file} can't be read: ${error.message}`,
        }),
    ),
  );
});

/**
 * Saves the sources file in `folder`, readable only by you. It's written
 * beside the old one and moved over it, so a failed write leaves the old one.
 */
export const write = Effect.fnUntraced(function* (
  folder: string,
  settings: Settings,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(folder, fileName);
  const next = `${file}.next`;

  yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });

  yield* fs.writeFileString(
    next,
    `${JSON.stringify(forFile(settings), null, 2)}\n`,
    { mode: 0o600 },
  );

  yield* fs.rename(next, file);
});
