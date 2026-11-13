/**
 * The sources the server serves, from the sources file, and finding one by
 * id. Each runs in a scope of its own, so a save from the Settings page
 * stops only the sources whose settings changed and starts their new ones.
 * A source that can't start, such as one with no address, is listed as not
 * connected with the reason, rather than stopping the server. Without a
 * sources file, it's the Raysharp recorder alone, as `swann`, from the
 * environment, until the first save.
 *
 * @module
 */
import {
  defaultClipHours,
  defaultContinuousHours,
  defaultDiskShare,
  defaultLimits,
  InvalidSettings,
  NotSupported,
  SourceUnavailable,
  UnknownSource,
  type CameraId,
  type CameraLabel,
  type Kind,
  type KindInfo,
  type RecordingSettings,
  type Settings,
  type Source,
  type SourceSettings,
} from "@timmo001/kestrel-core";
import * as Bambu from "@timmo001/kestrel-source-bambu";
import * as Raysharp from "@timmo001/kestrel-source-raysharp";
import * as Reolink from "@timmo001/kestrel-source-reolink";
import * as Streams from "@timmo001/kestrel-source-stream";
import * as Web from "@timmo001/kestrel-source-web";
import {
  Context,
  Effect,
  Equal,
  Exit,
  FileSystem,
  Layer,
  Path,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { configFolder } from "./Folders.ts";
import * as SourcesFile from "./SourcesFile.ts";

/** Every kind of source the server can run. */
const kinds: ReadonlyArray<Kind> = [
  Raysharp.kind,
  Reolink.kind,
  Bambu.kind,
  Streams.kind,
  Web.kind,
];

const kindInfos = kinds.map((kind) => kind.info);

/** The sources before there's a sources file: the recorder, from the environment. */
const firstSettings: Settings = {
  sources: [
    {
      id: "swann",
      kind: "raysharp",
      name: "Swann recorder",
      settings: {},
      cameras: [],
      secrets: [],
    },
  ],
  cameras: [],
  order: [],
  recording: {
    cameras: [],
    folder: null,
    continuousHours: defaultContinuousHours,
    clipHours: defaultClipHours,
    diskShare: defaultDiskShare,
    limits: defaultLimits,
  },
};

/** A source that couldn't start, listed with the reason and nothing else. */
const unstarted = (settings: SourceSettings, reason: string): Source => {
  const unavailable = Effect.fail(new SourceUnavailable({ message: reason }));

  return {
    id: settings.id,
    kind: settings.kind,
    name: settings.name,
    connection: Effect.succeed({
      connected: false,
      since: null,
      error: reason,
    }),
    attention: Effect.succeed([
      {
        source: settings.id,
        level: "alert",
        kind: "connection",
        message: `${settings.name} can't start: ${reason}`,
      },
    ]),
    cameras: unavailable,
    live: unavailable,
  };
};

interface Running {
  readonly settings: SourceSettings;
  readonly scope: Scope.Closeable;
  readonly source: Source;
}

interface State {
  readonly settings: Settings;
  readonly running: ReadonlyArray<Running>;
}

export class Sources extends Context.Service<
  Sources,
  {
    /** The sources running now. */
    readonly all: Effect.Effect<ReadonlyArray<Source>>;
    /** The sources running now, then again each time a save changes them. */
    readonly changes: Stream.Stream<ReadonlyArray<Source>>;
    /** The source with this id. */
    readonly find: (id: string) => Effect.Effect<Source, UnknownSource>;
    /** The kinds of source the server can run, and the settings each takes. */
    readonly kinds: ReadonlyArray<KindInfo>;
    /** The labels you gave cameras. */
    readonly labels: Effect.Effect<ReadonlyArray<CameraLabel>>;
    /** The order you gave cameras, by id; those it leaves out follow. */
    readonly order: Effect.Effect<ReadonlyArray<CameraId>>;
    /** What the server records itself, then again each time a save changes it. */
    readonly recording: Stream.Stream<RecordingSettings>;
    /** The settings as they're read back, with secrets left out. */
    readonly settings: Effect.Effect<Settings>;
    /**
     * Checks and saves settings from the page, keeping each secret it left
     * out, then restarts the sources whose settings changed.
     */
    readonly save: (
      settings: Settings,
    ) => Effect.Effect<Settings, InvalidSettings>;
  }
>()("@timmo001/kestrel-server/Sources") {
  static readonly layer = Layer.effect(
    Sources,
    Effect.gen(function* () {
      const folder = yield* configFolder;

      // Saves run from the API's handlers, with the files the layer was given
      const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

      const saved = yield* SourcesFile.read(folder);
      const scope = yield* Effect.scope;

      const start = Effect.fnUntraced(function* (settings: SourceSettings) {
        const own = yield* Scope.fork(scope);
        const kind = kinds.find((each) => each.info.kind === settings.kind);

        const source =
          kind === undefined
            ? unstarted(
                settings,
                `there's no kind of source called ${settings.kind}`,
              )
            : yield* kind.make(settings).pipe(
                Scope.provide(own),
                Effect.catch((error) =>
                  Effect.succeed(unstarted(settings, error.message)),
                ),
              );

        return { settings, scope: own, source };
      });

      const startAll = (settings: Settings) =>
        Effect.forEach(settings.sources, start, { concurrency: "unbounded" });

      const first = saved ?? firstSettings;

      const state = yield* SubscriptionRef.make<State>({
        settings: first,
        running: yield* startAll(first),
      });

      yield* Effect.addFinalizer(() =>
        SubscriptionRef.get(state).pipe(
          Effect.flatMap(({ running }) =>
            Effect.forEach(running, (each) =>
              Scope.close(each.scope, Exit.void),
            ),
          ),
        ),
      );

      /** Moves to new settings: stops the sources that changed or went, then starts the new ones. */
      const apply = Effect.fnUntraced(function* (next: Settings) {
        const { running } = yield* SubscriptionRef.get(state);

        const kept = running.filter((each) =>
          next.sources.some((settings) =>
            Equal.equals(settings, each.settings),
          ),
        );

        yield* Effect.forEach(
          running.filter((each) => !kept.includes(each)),
          (each) => Scope.close(each.scope, Exit.void),
          { concurrency: "unbounded" },
        );

        const started = yield* Effect.forEach(
          next.sources,
          (settings) => {
            const same = kept.find((each) =>
              Equal.equals(settings, each.settings),
            );

            return same === undefined ? start(settings) : Effect.succeed(same);
          },
          { concurrency: "unbounded" },
        );

        yield* SubscriptionRef.set(state, { settings: next, running: started });
      });

      const saving = yield* Semaphore.make(1);

      const current = SubscriptionRef.get(state);

      const all = current.pipe(
        Effect.map(({ running }) => running.map((each) => each.source)),
      );

      const save = Effect.fn("Sources.save")(
        function* (incoming: Settings) {
          const before = yield* current;

          if (incoming.revision !== SourcesFile.revisionOf(before.settings)) {
            return yield* new InvalidSettings({
              message:
                "The settings have changed since this page read them, such as from another tab; reload them and save again",
            });
          }

          const next = SourcesFile.restored(
            kindInfos,
            incoming,
            before.settings,
          );

          const problems = SourcesFile.problems(kindInfos, next);

          if (problems.length > 0) {
            return yield* new InvalidSettings({ message: problems.join("; ") });
          }

          yield* SourcesFile.write(folder, next).pipe(
            Effect.provideContext(files),
            Effect.mapError(
              (error) =>
                new InvalidSettings({
                  message: `The sources file couldn't be saved: ${error.message}`,
                }),
            ),
          );

          yield* apply(next);

          yield* Effect.logInfo(`Saved ${next.sources.length} sources`);

          return SourcesFile.shown(kindInfos, next);
        },
        (effect) => saving.withPermit(effect),
      );

      return Sources.of({
        all,
        changes: SubscriptionRef.changes(state).pipe(
          Stream.map(({ running }) => running.map((each) => each.source)),
        ),
        find: (id) =>
          all.pipe(
            Effect.flatMap((sources) => {
              const found = sources.find((source) => source.id === id);

              return found === undefined
                ? Effect.fail(
                    new UnknownSource({ message: `There's no source ${id}` }),
                  )
                : Effect.succeed(found);
            }),
          ),
        kinds: kindInfos,
        labels: current.pipe(Effect.map(({ settings }) => settings.cameras)),
        order: current.pipe(Effect.map(({ settings }) => settings.order)),
        recording: SubscriptionRef.changes(state).pipe(
          Stream.map(({ settings }) => settings.recording),
          Stream.changesWith((a, b) => Equal.equals(a, b)),
        ),
        settings: current.pipe(
          Effect.map(({ settings }) => SourcesFile.shown(kindInfos, settings)),
        ),
        save,
      });
    }),
  );
}

/** A source's optional capability, or `NotSupported` when it hasn't one. */
export const capability = <A>(
  source: Source,
  value: A | undefined,
  what: string,
) =>
  value === undefined
    ? Effect.fail(
        new NotSupported({ message: `${source.name} has no ${what}` }),
      )
    : Effect.succeed(value);
