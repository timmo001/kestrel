/**
 * The recorder as the server sees it: one logged-in session, opened when the
 * server starts and reopened with backoff whenever it drops, with the alarm
 * reports it sends kept and passed on.
 *
 * @module
 */
import {
  Session,
  type AlarmEvent,
  type DeviceInfo,
  type RecordedDay,
  type RecorderStatus,
  type Recording,
} from "@timmo001/dvr-revival-rsnet";
import {
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect";
import {
  RecorderUnavailable,
  type Connection,
  type ReceivedEvent,
} from "./Api.ts";

/** How many alarm reports the server keeps for a page that opens later. */
const keptEvents = 200;

const retry = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

export class Recorder extends Context.Service<
  Recorder,
  {
    readonly connection: Effect.Effect<Connection>;
    readonly device: Effect.Effect<DeviceInfo, RecorderUnavailable>;
    readonly status: Effect.Effect<RecorderStatus, RecorderUnavailable>;
    /** Recordings on one channel (from 1) on one day, such as `2026-11-11`. */
    readonly recordings: (
      channel: number,
      date: string,
    ) => Effect.Effect<Array<Recording>, RecorderUnavailable>;
    /** Days with recordings on any channel in a month, such as `2026-11`. */
    readonly recordedDays: (
      month: string,
    ) => Effect.Effect<Array<RecordedDay>, RecorderUnavailable>;
    /** The newest alarm reports, newest first. */
    readonly recentEvents: Effect.Effect<ReadonlyArray<ReceivedEvent>>;
    /** Alarm reports as they arrive. */
    readonly events: Stream.Stream<ReceivedEvent>;
  }
>()("@timmo001/dvr-revival-server/Recorder") {
  static readonly layer = Layer.effect(
    Recorder,
    Effect.gen(function* () {
      const host = yield* Config.String("DVR_HOST");
      const port = yield* Config.Int("DVR_PORT").pipe(Config.withDefault(9000));
      const username = yield* Config.Redacted("DVR_USERNAME");
      const password = yield* Config.Redacted("DVR_PASSWORD");

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
        use: (
          session: Session.Session,
        ) => Effect.Effect<A, Session.SessionError>,
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
        recentEvents: Ref.get(recent),
        events: Stream.fromPubSub(events),
      });
    }),
  );
}

/** The last day of a month such as `2026-11`, as two digits. */
const lastDay = (month: string) => {
  const [year = 1970, number = 1] = month.split("-").map(Number);

  return String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(
    2,
    "0",
  );
};
