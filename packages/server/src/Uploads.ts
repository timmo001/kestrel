/**
 * Clips cameras send to Kestrel themselves, such as a Reolink camera's FTP
 * uploads when it sees motion, so a clip only on its SD card can still be
 * played. It runs an upload-only FTP receiver on `KESTREL_FTP_PORT`, 7381
 * by default, with data on the ten ports from 7390, on the address the
 * server listens on, makes each source its
 * own login, kept in the state folder, and files each clip in the
 * recordings folder as a motion clip, from when its source reads it starts
 * from its name. Anything that isn't a clip is read and dropped. Clips are
 * kept for the clip hours, as the clear-out keeps them.
 *
 * @module
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  SourceUnavailable,
  type NotSupported,
  type Source,
  type UploadCheck,
  type UploadState,
  type UploadTarget,
} from "@timmo001/kestrel-core";
import * as Nvr from "@timmo001/kestrel-nvr";
import * as Ftp from "@timmo001/kestrel-protocol-ftp";
import {
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ownRecordingsFolder, stateFolder } from "./Folders.ts";
import { capability, Sources } from "./Sources.ts";

/** The first of the ports data comes in on. */
const passiveFrom = 7390;

/** How many ports data comes in on, for as many cameras sending at once. */
const passiveCount = 10;

const Stored = Schema.Struct({
  /** Each source's password, by its id, which is also its login. */
  logins: Schema.Record(Schema.String, Schema.String),
});

interface Stored extends Schema.Schema.Type<typeof Stored> {}

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));

/** Whether two passwords match, taking as long whatever they are. */
const same = (kept: string, given: string) => {
  const a = Buffer.from(kept);
  const b = Buffer.from(given);

  return a.length === b.length && timingSafeEqual(a, b);
};

export class Uploads extends Context.Service<
  Uploads,
  {
    /** Whether a source's cameras send their clips to Kestrel now. */
    readonly state: (
      source: Source,
    ) => Effect.Effect<UploadState, NotSupported | SourceUnavailable>;
    /** Points a source's cameras at Kestrel, or stops them sending. */
    readonly change: (
      source: Source,
      on: boolean,
    ) => Effect.Effect<UploadCheck, NotSupported | SourceUnavailable>;
  }
>()("@timmo001/kestrel-server/Uploads") {
  static readonly layer = Layer.effect(
    Uploads,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sources = yield* Sources;
      const own = yield* ownRecordingsFolder;
      const directory = yield* stateFolder;
      const file = path.join(directory, "uploads.json");

      const port = yield* Config.Int("KESTREL_FTP_PORT").pipe(
        Config.withDefault(7381),
      );

      // Where the server itself listens, so one held to this machine keeps it too
      const host = yield* Config.String("KESTREL_HOST").pipe(
        Config.withDefault("::"),
      );

      const stored = yield* Ref.make<Stored>(
        yield* fs.readFileString(file).pipe(
          Effect.map(decodeStored),
          Effect.orElseSucceed(() => Option.none<Stored>()),
          Effect.map(Option.getOrElse(() => ({ logins: {} }))),
        ),
      );

      /** When each source's last clip came, as an ISO time. */
      const last = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

      /** A source's login, made the first time it's asked for. */
      const loginFor = Effect.fnUntraced(function* (id: string) {
        const kept = (yield* Ref.get(stored)).logins[id];

        if (kept !== undefined) return kept;

        const made = randomBytes(18).toString("base64url");

        const next = yield* Ref.updateAndGet(stored, (was) => ({
          logins: { ...was.logins, [id]: made },
        }));

        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(
            Effect.andThen(
              fs.writeFileString(file, JSON.stringify(next), { mode: 0o600 }),
            ),
            Effect.mapError(
              (error) =>
                new SourceUnavailable({
                  message: `Kestrel couldn't keep a login for the camera: ${error.message}`,
                }),
            ),
          );

        return made;
      });

      const receive = Effect.fnUntraced(function* (upload: Ftp.Upload) {
        const source = yield* sources
          .find(upload.user)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined));

        const clip =
          source?.uploads === undefined
            ? null
            : yield* source.uploads.clip(upload.path);

        if (source === undefined || clip === null) {
          return yield* Stream.runDrain(upload.data);
        }

        const settings = (yield* sources.settings).recording;

        yield* Nvr.Store.save(
          {
            folder: settings.folder ?? own,
            key: clip.camera,
            begin: clip.begin,
            tags: ["motion"],
          },
          upload.data,
        );

        const now = new Date(yield* Clock.currentTimeMillis).toISOString();

        yield* Ref.update(last, (was) => new Map(was).set(source.id, now));
        yield* Effect.logInfo(
          `Kept a clip ${clip.camera} sent, from ${clip.begin.replace("T", " ")}`,
        );
      });

      const listening = yield* Ftp.serve({
        port,
        host,
        passive: { from: passiveFrom, to: passiveFrom + passiveCount - 1 },
        check: (user, password) =>
          Ref.get(stored).pipe(
            Effect.map((now) => {
              const kept = now.logins[user];

              return kept !== undefined && same(kept, Redacted.value(password));
            }),
          ),
        receive: (upload) =>
          receive(upload).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                `A file ${upload.user} sent wasn't kept: ${String(error)}`,
              ),
            ),
          ),
      }).pipe(
        Effect.tap((receiver) =>
          Effect.logInfo(`Taking clips from cameras on port ${receiver.port}`),
        ),
        Effect.map(Option.some),
        Effect.catch((error) =>
          Effect.logWarning(
            `Clips from cameras can't be taken on port ${port}: ${error.message}`,
          ).pipe(Effect.as(Option.none<Ftp.Receiver>())),
        ),
      );

      const targetFor = Effect.fnUntraced(function* (source: Source) {
        if (Option.isNone(listening)) {
          return yield* new SourceUnavailable({
            message: `Kestrel can't take clips from cameras, as port ${port} is in use`,
          });
        }

        return {
          port: listening.value.port,
          user: source.id,
          password: Redacted.make(yield* loginFor(source.id)),
        } satisfies UploadTarget;
      });

      return Uploads.of({
        state: Effect.fnUntraced(function* (source) {
          const uploads = yield* capability(
            source,
            source.uploads,
            "clips to send",
          );

          const lastClip = (yield* Ref.get(last)).get(source.id) ?? null;

          if (Option.isNone(listening)) return { on: false, last: lastClip };

          return {
            on: yield* uploads.sending(yield* targetFor(source)),
            last: lastClip,
          };
        }),
        change: Effect.fnUntraced(function* (source, on) {
          const uploads = yield* capability(
            source,
            source.uploads,
            "clips to send",
          );

          if (!on) return yield* uploads.send(null);

          return yield* uploads.send(yield* targetFor(source));
        }),
      });
    }),
  );
}
