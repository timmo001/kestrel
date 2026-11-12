/**
 * A Raysharp recorder as a source: one logged-in session, opened when the
 * server starts and reopened with backoff whenever it drops, with the alarm
 * reports it sends kept and passed on. Each channel is a camera, such as
 * `swann/3`, with its RTSP streams for live view and its recordings. The
 * recorder's address and login come from the environment: `DVR_HOST`,
 * `DVR_USERNAME` and `DVR_PASSWORD`, with `DVR_PORT` and `DVR_RTSP_PORT`
 * when they aren't the defaults, and `DVR_RTSP_USERNAME` or
 * `DVR_RTSP_PASSWORD` for a separate RTSP login.
 *
 * @module
 */
import {
  cameraId,
  NoRecordings,
  SourceUnavailable,
  UnknownCamera,
  type AlarmEvent,
  type CameraInfo,
  type Connection,
  type LiveFeed,
  type RecordedFrame,
  type ReceivedEvent,
  type Recording,
  type Source,
  type SourceId,
} from "@timmo001/kestrel-core";
import { Session } from "@timmo001/kestrel-rsnet";
import {
  Config,
  DateTime,
  Duration,
  Effect,
  Option,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { fromSeconds, stretches, toSeconds } from "./Stretches.ts";

/** How many alarm reports the source keeps for a page that opens later. */
const keptEvents = 200;

/** How many times, a second apart, to wait for the recorder to finish another playback. */
const busyTries = 15;

/**
 * Opens a recorded stream again while the recorder is busy with another
 * playback or download; it lets go of the last a few seconds after it
 * closes, such as when the player changes speed. Busy only comes before the
 * first frame, so opening again repeats nothing.
 */
const whenFree = (
  open: () => Stream.Stream<RecordedFrame, Session.SessionError>,
  tries = busyTries,
): Stream.Stream<RecordedFrame, Session.SessionError> =>
  open().pipe(
    Stream.catchTag("RecorderBusy", (busy) =>
      tries <= 1
        ? Stream.fail(busy)
        : Stream.unwrap(
            Effect.sleep(Duration.seconds(1)).pipe(
              Effect.as(whenFree(open, tries - 1)),
            ),
          ),
    ),
  );

const retry = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

const twoDigits = (channel: number) => String(channel).padStart(2, "0");

/** The last day of a month such as `2026-11`, as two digits. */
const lastDay = (month: string) => {
  const [year = 1970, number = 1] = month.split("-").map(Number);

  return String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(
    2,
    "0",
  );
};

/** The recorder's channels, from 1. */
const channelsOf = (opened: Session.Session) =>
  Array.from({ length: opened.device.channels }, (_, index) => index + 1);

export interface Options {
  /** The source's id, which its cameras' ids start with, such as `swann`. */
  readonly id: SourceId;
  readonly name: string;
}

/** A Raysharp recorder as a source, logged in for as long as the scope lasts. */
export const make = Effect.fnUntraced(function* (options: Options) {
  const id = options.id;
  const host = yield* Config.String("DVR_HOST");
  const port = yield* Config.Int("DVR_PORT").pipe(Config.withDefault(9000));
  const username = yield* Config.Redacted("DVR_USERNAME");
  const password = yield* Config.Redacted("DVR_PASSWORD");

  const rtspPort = yield* Config.Int("DVR_RTSP_PORT").pipe(
    Config.withDefault(554),
  );

  // Some recorders keep a separate RTSP login; otherwise it's the same one
  const rtspUsername = yield* Config.Redacted("DVR_RTSP_USERNAME").pipe(
    Config.orElse(() => Config.Redacted("DVR_USERNAME")),
  );

  const rtspPassword = yield* Config.Redacted("DVR_RTSP_PASSWORD").pipe(
    Config.orElse(() => Config.Redacted("DVR_PASSWORD")),
  );

  const rtsp = (channel: number, stream: 0 | 1) =>
    Redacted.make(
      `rtsp://${encodeURIComponent(Redacted.value(rtspUsername))}:${encodeURIComponent(Redacted.value(rtspPassword))}@${host}:${rtspPort}/ch${twoDigits(channel)}/${stream}`,
    );

  const current = yield* Ref.make(Option.none<Session.Session>());

  const connection = yield* Ref.make<Connection>({
    connected: false,
    since: null,
    error: null,
  });

  const recent = yield* Ref.make<ReadonlyArray<ReceivedEvent>>([]);
  const events = yield* PubSub.sliding<ReceivedEvent>(256);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const receive = Effect.fnUntraced(function* (event: AlarmEvent) {
    const received: ReceivedEvent = {
      source: id,
      camera:
        event.channel === null ? null : cameraId(id, String(event.channel)),
      kind: event.kind,
      subtype: event.subtype,
      active: event.active,
      time: event.time,
      size: event.size,
      receivedAt: yield* now,
    };

    yield* Ref.update(recent, (list) =>
      [received, ...list].slice(0, keptEvents),
    );

    yield* PubSub.publish(events, received);
  });

  const session = Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* Session.connect({
        host,
        port,
        username,
        password,
        alarms: true,
      });

      yield* Ref.set(current, Option.some(opened));

      yield* Ref.set(connection, {
        connected: true,
        since: yield* now,
        error: null,
      });

      yield* Effect.logInfo(
        `Logged in to ${opened.device.name} (${opened.device.firmware})`,
      );

      yield* opened.alarms.pipe(Stream.runForEach(receive), Effect.forkScoped);

      return yield* opened.closed;
    }),
  ).pipe(
    Effect.ensuring(Ref.set(current, Option.none())),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const message = error.message;

        yield* Ref.set(connection, {
          connected: false,
          since: yield* now,
          error: message,
        });

        yield* Effect.logWarning(`Recorder session ended: ${message}`);
      }),
    ),
  );

  yield* session.pipe(Effect.retry(retry), Effect.forkScoped);

  const unavailable = (error: Session.SessionError) =>
    new SourceUnavailable({ message: error.message });

  /** The open session, or why there isn't one. */
  const opened = Ref.get(current).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new SourceUnavailable({
              message: "Not logged in to the recorder yet",
            }),
          ),
        onSome: (open) => Effect.succeed(open),
      }),
    ),
  );

  /** The channel a camera's own id names, such as `3`, if the recorder has it. */
  const channelOf = (open: Session.Session, camera: string) => {
    const channel = Number(camera);

    return /^[1-9]\d*$/.test(camera) && channel <= open.device.channels
      ? Effect.succeed(channel)
      : Effect.fail(
          new UnknownCamera({
            message: `The recorder has no camera ${cameraId(id, camera)}`,
          }),
        );
  };

  const source: Source = {
    id,
    kind: "raysharp",
    name: options.name,
    connection: Ref.get(connection),
    cameras: Effect.gen(function* () {
      const open = yield* opened;
      const status = yield* open.status.pipe(Effect.option);

      return channelsOf(open).map((channel): CameraInfo => {
        const state = Option.getOrUndefined(status)?.channels.find(
          (each) => each.channel === channel,
        );

        return {
          id: cameraId(id, String(channel)),
          name: `Channel ${channel}`,
          channel,
          signal: state === undefined ? null : !state.videoLoss,
          live: true,
          recordings: true,
          events: true,
        };
      });
    }),
    // The channel count comes from the login
    live: opened.pipe(
      Effect.map((open) =>
        channelsOf(open).map((channel): LiveFeed => ({
          camera: cameraId(id, String(channel)),
          main: rtsp(channel, 0),
          sub: rtsp(channel, 1),
        })),
      ),
    ),
    recordings: {
      days: (month) =>
        opened.pipe(
          Effect.flatMap((open) =>
            open
              .recordedDays({
                channels: channelsOf(open),
                begin: `${month}-01T00:00:00`,
                end: `${month}-${lastDay(month)}T23:59:59`,
              })
              .pipe(Effect.mapError(unavailable)),
          ),
        ),
      list: Effect.fnUntraced(function* (camera, date) {
        const open = yield* opened;
        const channel = yield* channelOf(open, camera);

        const found = yield* open
          .recordings({
            channel,
            begin: `${date}T00:00:00`,
            end: `${date}T23:59:59`,
          })
          .pipe(Effect.mapError(unavailable));

        return found.map((recording): Recording => ({
          camera: cameraId(id, camera),
          begin: recording.begin,
          end: recording.end,
          reasons: recording.reasons,
          bytes: recording.bytes,
        }));
      }),
      video: Effect.fnUntraced(function* (options) {
        const open = yield* opened;
        const channel = yield* channelOf(open, options.camera);

        const found = yield* open
          .recordings({
            channel,
            // From an hour before, for a file that starts earlier and runs
            // into the range, to a minute after, for whether the next file
            // follows straight on
            begin: fromSeconds(toSeconds(options.begin) - 3600),
            end: fromSeconds(toSeconds(options.end) + 60),
          })
          .pipe(Effect.mapError(unavailable));

        const parts = stretches(found, options.begin, options.end);

        if (parts.length === 0) {
          return yield* new NoRecordings({
            message: `Nothing was recorded on ${cameraId(id, options.camera)} from ${options.begin} to ${options.end}`,
          });
        }

        const every = options.every;

        // A file at a time, whole or key frames only
        return Stream.fromIterable(parts).pipe(
          Stream.flatMap((part) =>
            whenFree(() =>
              every === undefined
                ? open.download({
                    channel,
                    stream: options.stream,
                    begin: part.begin,
                    end: part.end,
                  })
                : open.keyFrames({
                    channel,
                    stream: options.stream,
                    begin: part.begin,
                    end: part.end,
                    every,
                  }),
            ),
          ),
          Stream.mapError(unavailable),
        );
      }),
    },
    events: {
      recent: Ref.get(recent),
      live: Stream.fromPubSub(events),
    },
    details: {
      device: Effect.map(opened, (open) => open.device),
      status: opened.pipe(
        Effect.flatMap((open) =>
          open.status.pipe(Effect.mapError(unavailable)),
        ),
      ),
    },
  };

  return source;
});
