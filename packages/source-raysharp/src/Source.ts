/**
 * A Raysharp recorder as a source: one logged-in session, opened when the
 * server starts and reopened with backoff whenever it drops, with the alarm
 * reports it sends kept and passed on, and each channel's RTSP streams for
 * live view. The recorder's address and login come from the environment:
 * `DVR_HOST`, `DVR_USERNAME` and `DVR_PASSWORD`, with `DVR_PORT` and
 * `DVR_RTSP_PORT` when they aren't the defaults, and `DVR_RTSP_USERNAME` or
 * `DVR_RTSP_PASSWORD` for a separate RTSP login.
 *
 * @module
 */
import {
  NoRecordings,
  Recorder,
  RecorderUnavailable,
  type AlarmEvent,
  type Connection,
  type LiveFeed,
  type LiveStream,
  type RecordedFrame,
  type ReceivedEvent,
} from "@timmo001/kestrel-core";
import { Session } from "@timmo001/kestrel-rsnet";
import {
  Config,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { fromSeconds, stretches, toSeconds } from "./Stretches.ts";

/** How many alarm reports the server keeps for a page that opens later. */
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

/** Each channel's live stream, named as go2rtc serves it. */
export const streamsFor = (channels: number): Array<LiveStream> =>
  Array.from({ length: channels }, (_, index) => {
    const channel = index + 1;

    return {
      channel,
      name: `Channel ${channel}`,
      main: `ch${twoDigits(channel)}`,
      sub: `ch${twoDigits(channel)}_sub`,
    };
  });

/** The recorder as the `Recorder` service. */
export const layer = Layer.effect(
  Recorder,
  Effect.gen(function* () {
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
        kind: event.kind,
        subtype: event.subtype,
        channel: event.channel,
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

        yield* opened.alarms.pipe(
          Stream.runForEach(receive),
          Effect.forkScoped,
        );

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

    const withSession = <A>(
      use: (session: Session.Session) => Effect.Effect<A, Session.SessionError>,
    ) =>
      Ref.get(current).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new RecorderUnavailable({
                  message: "Not logged in to the recorder yet",
                }),
              ),
            onSome: (opened) =>
              use(opened).pipe(
                Effect.mapError(
                  (error) =>
                    new RecorderUnavailable({ message: error.message }),
                ),
              ),
          }),
        ),
      );

    return Recorder.of({
      connection: Ref.get(connection),
      device: withSession((opened) => Effect.succeed(opened.device)),
      status: withSession((opened) => opened.status),
      recordings: (channel, date) =>
        withSession((opened) =>
          opened.recordings({
            channel,
            begin: `${date}T00:00:00`,
            end: `${date}T23:59:59`,
          }),
        ),
      recordedDays: (month) =>
        withSession((opened) =>
          opened.recordedDays({
            channels: Array.from(
              { length: opened.device.channels },
              (_, index) => index + 1,
            ),
            begin: `${month}-01T00:00:00`,
            end: `${month}-${lastDay(month)}T23:59:59`,
          }),
        ),
      recorded: Effect.fnUntraced(function* (options) {
        const { opened, found } = yield* withSession((opened) =>
          opened
            .recordings({
              channel: options.channel,
              // From an hour before, for a file that starts earlier and
              // runs into the range, to a minute after, for whether the
              // next file follows straight on
              begin: fromSeconds(toSeconds(options.begin) - 3600),
              end: fromSeconds(toSeconds(options.end) + 60),
            })
            .pipe(Effect.map((list) => ({ opened, found: list }))),
        );

        const parts = stretches(found, options.begin, options.end);

        if (parts.length === 0) {
          return yield* new NoRecordings({
            message: `Nothing was recorded on channel ${options.channel} from ${options.begin} to ${options.end}`,
          });
        }

        const every = options.every;

        // A file at a time, whole or key frames only
        return Stream.fromIterable(parts).pipe(
          Stream.flatMap((part) =>
            whenFree(() =>
              every === undefined
                ? opened.download({
                    channel: options.channel,
                    stream: options.stream,
                    begin: part.begin,
                    end: part.end,
                  })
                : opened.keyFrames({
                    channel: options.channel,
                    stream: options.stream,
                    begin: part.begin,
                    end: part.end,
                    every,
                  }),
            ),
          ),
          Stream.mapError(
            (error) => new RecorderUnavailable({ message: error.message }),
          ),
        );
      }),
      recentEvents: Ref.get(recent),
      events: Stream.fromPubSub(events),
      // The channel count comes from the login
      live: withSession((opened) =>
        Effect.succeed(
          streamsFor(opened.device.channels).map((stream): LiveFeed => ({
            stream,
            main: rtsp(stream.channel, 0),
            sub: rtsp(stream.channel, 1),
          })),
        ),
      ),
    });
  }),
);

/** The last day of a month such as `2026-11`, as two digits. */
const lastDay = (month: string) => {
  const [year = 1970, number = 1] = month.split("-").map(Number);

  return String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(
    2,
    "0",
  );
};
