/**
 * A Bambu Lab P1 or A1 printer as a source, with its camera as one camera
 * that has a still picture. It keeps the camera feed open on port 6000,
 * logged in with the printer's LAN access code, reopened with backoff when
 * it drops, and serves the newest picture. Its certificate is the
 * printer's own, so it isn't checked.
 *
 * @module
 */
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import {
  cameraId,
  InvalidSettings,
  SourceUnavailable,
  UnknownCamera,
  type CameraInfo,
  type Connection,
  type Kind,
  type Source,
  type SourceSettings,
  type StillPicture,
} from "@timmo001/kestrel-core";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from "effect";
import * as Socket from "effect/socket/Socket";
import { cameraPort, loginPacket, pictureReader } from "./Camera.ts";

/** How long the feed can go without sending anything before it's reopened. */
const quietFor = Duration.seconds(20);

/** How old the newest picture can be and still be served, in milliseconds. */
const stalePicture = 30_000;

const retry = Schedule.min([
  Schedule.exponential(Duration.seconds(2)),
  Schedule.spaced(Duration.seconds(30)),
]);

const BambuSettings = Schema.Struct({
  host: Schema.String,
  accessCode: Schema.String,
});

const decodeSettings = Schema.decodeUnknownEffect(BambuSettings);

/** The feed stopped, and why. */
class FeedStopped extends Schema.TaggedError<FeedStopped>()("FeedStopped", {
  message: Schema.String,
}) {}

/** What the app shows when you add or change a Bambu Lab printer. */
export const info: Kind["info"] = {
  kind: "bambu",
  name: "Bambu Lab printer",
  description:
    "A Bambu Lab P1 or A1 printer's camera, as a picture every few seconds, over your network",
  fields: [
    {
      key: "host",
      label: "Address",
      type: "text",
      required: true,
      hint: "Its address on your network, such as 192.0.2.40",
    },
    {
      key: "accessCode",
      label: "Access code",
      type: "secret",
      required: true,
      hint: "The LAN access code on the printer's network settings screen",
    },
  ],
  cameraFields: null,
};

/** A Bambu Lab printer as a source, with its camera feed open for as long as the scope lasts. */
export const make = Effect.fnUntraced(function* (saved: SourceSettings) {
  const id = saved.id;
  const name = saved.name;
  const camera = cameraId(id, "camera");

  const settings = yield* decodeSettings(
    Object.fromEntries(
      Object.entries(saved.settings).filter(([, value]) => value !== ""),
    ),
  ).pipe(
    Effect.mapError(
      () =>
        new InvalidSettings({
          message: `${name}: it needs an address and an access code`,
        }),
    ),
  );

  const accessCode = Redacted.make(settings.accessCode);

  const latest = yield* Ref.make(
    Option.none<{ readonly picture: Uint8Array; readonly at: number }>(),
  );

  const connection = yield* Ref.make<Connection>({
    connected: false,
    since: null,
    error: null,
  });

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const stopped = (error: Socket.SocketError) =>
    new FeedStopped({
      message: Predicate.isTagged(error.reason, "SocketOpenError")
        ? "can't be reached"
        : "closed its camera feed, which it does for a wrong access code",
    });

  /** Reads pictures until the feed stops. */
  const feed = Effect.gen(function* () {
    const socket = yield* NodeSocket.makeTls({
      host: settings.host,
      port: cameraPort,
      rejectUnauthorized: false,
      openTimeout: Duration.seconds(10),
    });

    const pull = yield* Socket.readerBytes(socket).pipe(
      Effect.mapError(stopped),
    );

    const write = (yield* socket.writer).write;
    const login = loginPacket(Redacted.value(accessCode));

    yield* write(login).pipe(
      Effect.mapError(stopped),
      Effect.ensuring(Effect.sync(() => login.fill(0))),
    );

    const read = pictureReader();

    for (;;) {
      const chunks = yield* pull.pipe(
        Effect.mapError(stopped),
        Effect.timeoutOrElse({
          duration: quietFor,
          orElse: () =>
            Effect.fail(
              new FeedStopped({ message: "stopped sending pictures" }),
            ),
        }),
      );

      for (const chunk of chunks) {
        const { pictures, problem } = read(chunk);
        const newest = pictures.at(-1);

        if (newest !== undefined) {
          const at = yield* Clock.currentTimeMillis;

          yield* Ref.set(latest, Option.some({ picture: newest, at }));

          const state = yield* Ref.get(connection);

          if (!state.connected) {
            yield* Ref.set(connection, {
              connected: true,
              since: yield* now,
              error: null,
            });

            yield* Effect.logInfo(`${name}'s camera is sending pictures`);
          }
        }

        if (problem !== null) {
          return yield* new FeedStopped({ message: problem });
        }
      }
    }
  }).pipe(Effect.scoped);

  yield* feed.pipe(
    Effect.tapError((error) =>
      Effect.gen(function* () {
        yield* Ref.set(connection, {
          connected: false,
          since: yield* now,
          error: error.message,
        });

        yield* Effect.logWarning(`${name} ${error.message}`);
      }),
    ),
    Effect.retry(retry),
    Effect.forkScoped,
  );

  const unavailable = (message: string) =>
    new SourceUnavailable({ message: `${name} ${message}` });

  const source: Source = {
    id,
    kind: "bambu",
    name,
    connection: Ref.get(connection),
    attention: Ref.get(connection).pipe(
      Effect.map((state) =>
        state.connected || state.since === null
          ? []
          : [
              {
                source: id,
                level: "alert",
                kind: "connection",
                message: `Can't see ${name}'s camera${state.error === null ? "" : `: it ${state.error}`}`,
              },
            ],
      ),
    ),
    cameras: Effect.succeed([
      {
        id: camera,
        name,
        channel: null,
        signal: null,
        live: false,
        still: true,
        recordings: false,
        events: false,
      } satisfies CameraInfo,
    ]),
    live: Effect.succeed([]),
    stills: {
      still: Effect.fnUntraced(function* (wanted) {
        if (wanted !== camera) {
          return yield* new UnknownCamera({
            message: `${name} has no camera ${wanted}`,
          });
        }

        const newest = yield* Ref.get(latest);
        const at = yield* Clock.currentTimeMillis;

        if (Option.isNone(newest)) {
          return yield* unavailable("hasn't sent a picture yet");
        }

        if (at - newest.value.at > stalePicture) {
          return yield* unavailable("hasn't sent a picture lately");
        }

        return {
          data: newest.value.picture,
          contentType: "image/jpeg",
        } satisfies StillPicture;
      }),
    },
  };

  return source;
});
