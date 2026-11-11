/**
 * One logged-in control connection to a recorder: it sends heartbeats, matches
 * replies to requests by sequence number, and passes alarm reports on as a
 * stream. The connection closes with the scope it was opened in.
 *
 * @module
 */
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import {
  Deferred,
  Duration,
  Effect,
  PubSub,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as Socket from "effect/socket/Socket";
import { encodeFrame, frameDecoder, type Frame } from "./Codec.ts";
import type {
  AlarmEvent,
  DeviceInfo,
  LocalTime,
  RecordedDay,
  RecorderStatus,
  Recording,
} from "./Domain.ts";
import {
  MessageType,
  Subtype,
  ackReasons,
  isRaysharpLogin,
  loginRequest,
  parseAlarm,
  parseLogin,
  parseRecordedDays,
  parseRecordings,
  parseStatus,
  recordQuery,
  statusMinimumSize,
} from "./Messages.ts";

/** The recorder turned the login down. */
export class LoginRefused extends Schema.TaggedError<LoginRefused>()(
  "LoginRefused",
  {
    ack: Schema.Number,
    reason: Schema.String,
  },
) {
  override get message() {
    return `The recorder refused the login: ${this.reason}`;
  }
}

/** Whatever answered isn't a Raysharp recorder. */
export class NotRaysharp extends Schema.TaggedError<NotRaysharp>()(
  "NotRaysharp",
  {},
) {
  override get message() {
    return "That address isn't a Raysharp recorder";
  }
}

/** The recorder sent something this client can't read. */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()(
  "ProtocolError",
  {
    message: Schema.String,
  },
) {}

/** No reply came in time. */
export class RequestTimedOut extends Schema.TaggedError<RequestTimedOut>()(
  "RequestTimedOut",
  {
    type: Schema.Number,
    subtype: Schema.Number,
  },
) {
  override get message() {
    return `The recorder didn't answer message ${this.type}/${this.subtype}`;
  }
}

/** The connection couldn't open, or closed. */
export class ConnectionClosed extends Schema.TaggedError<ConnectionClosed>()(
  "ConnectionClosed",
  {
    message: Schema.String,
  },
) {}

export type SessionError =
  | LoginRefused
  | NotRaysharp
  | ProtocolError
  | RequestTimedOut
  | ConnectionClosed;

/** A reply to a request. Some replies carry ack 1 and still hold good data, so the ack is left to the caller. */
export type Reply = Frame;

export interface SessionOptions {
  readonly username: Redacted.Redacted;
  readonly password: Redacted.Redacted;
  /** Ask the recorder to send alarm reports. */
  readonly alarms?: boolean | undefined;
  /** How long to wait for each reply, 20 seconds by default. */
  readonly timeout?: Duration.Input | undefined;
}

export interface Session {
  readonly device: DeviceInfo;
  /** Sends any message and waits for its reply. */
  readonly request: (
    type: number,
    subtype: number,
    body?: Uint8Array,
  ) => Effect.Effect<Reply, SessionError>;
  readonly status: Effect.Effect<RecorderStatus, SessionError>;
  /** Recordings on one channel (from 1) between two recorder times. */
  readonly recordings: (options: {
    readonly channel: number;
    readonly begin: LocalTime;
    readonly end: LocalTime;
  }) => Effect.Effect<Array<Recording>, SessionError>;
  /** Days with recordings on any of the channels (from 1) between two recorder times. */
  readonly recordedDays: (options: {
    readonly channels: ReadonlyArray<number>;
    readonly begin: LocalTime;
    readonly end: LocalTime;
  }) => Effect.Effect<Array<RecordedDay>, SessionError>;
  /** Alarm reports, when the session asked for them. Ends when the connection closes. */
  readonly alarms: Stream.Stream<AlarmEvent>;
  /** Waits until the connection closes, failing with why. */
  readonly closed: Effect.Effect<never, SessionError>;
}

const heartbeatInterval = Duration.seconds(5);
const defaultTimeout = Duration.seconds(20);
const empty = new Uint8Array(0);

const closedBy = (error: Socket.SocketError) =>
  new ConnectionClosed({ message: error.message });

/** Logs in over an open socket. */
export const make = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  options: SessionOptions,
) {
  const timeout = options.timeout ?? defaultTimeout;

  const pull = yield* Socket.readerBytes(socket).pipe(
    Effect.mapError(closedBy),
  );

  const write = (yield* socket.writer).write;
  const alarms = yield* PubSub.sliding<AlarmEvent>(256);
  const closed = yield* Deferred.make<never, SessionError>();
  const pending = new Map<number, Deferred.Deferred<Frame, SessionError>>();
  let mode = 2;
  let sequence = 0;
  let open = true;

  const nextSequence = () => {
    sequence = (sequence + 1) >>> 0;

    return sequence;
  };

  const send = (
    number: number,
    type: number,
    subtype: number,
    body: Uint8Array,
  ) =>
    Effect.suspend(() =>
      write(encodeFrame({ mode, type, subtype, sequence: number, body })),
    ).pipe(Effect.mapError(closedBy));

  const request = (
    type: number,
    subtype: number,
    body: Uint8Array = empty,
  ): Effect.Effect<Reply, SessionError> =>
    Effect.gen(function* () {
      if (!open)
        return yield* new ConnectionClosed({
          message: "The connection is closed",
        });
      const reply = yield* Deferred.make<Frame, SessionError>();
      // Registered before sending, so a fast reply can't arrive first.
      const number = nextSequence();
      pending.set(number, reply);

      return yield* send(number, type, subtype, body).pipe(
        Effect.andThen(Deferred.await(reply)),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new RequestTimedOut({ type, subtype })),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(number))),
      );
    });

  const dispatch = (frame: Frame) => {
    if (frame.type === MessageType.alarmReport) {
      return PubSub.publish(alarms, parseAlarm(frame.subtype, frame.body)).pipe(
        Effect.asVoid,
      );
    }

    const waiting = pending.get(frame.sequence);

    return waiting === undefined
      ? Effect.void
      : Deferred.succeed(waiting, frame).pipe(Effect.asVoid);
  };

  const decode = frameDecoder();

  const readLoop = Effect.gen(function* () {
    for (;;) {
      const chunks = yield* pull.pipe(Effect.mapError(closedBy));

      for (const chunk of chunks) {
        const { frames, problem } = decode(chunk);

        for (const frame of frames) yield* dispatch(frame);

        if (problem !== undefined)
          return yield* new ProtocolError({ message: problem });
      }
    }
  });

  yield* readLoop.pipe(
    Effect.catch((error: SessionError) =>
      Effect.gen(function* () {
        open = false;

        for (const waiting of pending.values())
          yield* Deferred.fail(waiting, error);
        pending.clear();
        yield* PubSub.shutdown(alarms);
        yield* Deferred.fail(closed, error);
      }),
    ),
    Effect.forkScoped,
  );

  const credentials = loginRequest({
    username: Redacted.value(options.username),
    password: Redacted.value(options.password),
    alarms: options.alarms ?? false,
  });

  const login = yield* request(MessageType.login, 0, credentials).pipe(
    Effect.ensuring(Effect.sync(() => credentials.fill(0))),
  );

  if (login.ack !== 0) {
    return yield* new LoginRefused({
      ack: login.ack,
      reason: ackReasons.get(login.ack) ?? `ack ${login.ack}`,
    });
  }

  if (!isRaysharpLogin(login.body)) return yield* new NotRaysharp();
  mode = login.mode;
  const device = parseLogin(login.body);

  yield* Effect.suspend(() =>
    send(nextSequence(), MessageType.heartbeat, 0, empty),
  ).pipe(
    Effect.ignore,
    Effect.repeat(Schedule.spaced(heartbeatInterval)),
    Effect.forkScoped,
  );

  if (options.alarms === true) {
    // The login flag should be enough; asking explicitly as well covers
    // firmware that wants the subscription message.
    yield* request(MessageType.alarmSubscribe, Subtype.alarmDesired);
  }

  return {
    device,
    request,
    status: Effect.gen(function* () {
      // Status replies carry ack 1 even when they're filled in.
      const reply = yield* request(MessageType.status, Subtype.statusOnly);

      if (reply.body.length < statusMinimumSize) {
        return yield* new ProtocolError({
          message: `Status reply too short (${reply.body.length} bytes)`,
        });
      }

      return parseStatus(reply.body, device.channels);
    }),
    recordings: (search) =>
      request(
        MessageType.queryRecord,
        Subtype.recordDetail,
        recordQuery({ kind: "detail", ...search }),
      ).pipe(
        Effect.map((reply) => parseRecordings(reply.body, search.channel)),
      ),
    recordedDays: (search) =>
      request(
        MessageType.queryRecord,
        Subtype.recordDayOutline,
        recordQuery({ kind: "outline", ...search }),
      ).pipe(Effect.map((reply) => parseRecordedDays(reply.body))),
    alarms: Stream.fromPubSub(alarms),
    closed: Deferred.await(closed),
  } satisfies Session;
});

/** Opens a TCP connection to a recorder's control port (9000 by default) and logs in. */
export const connect = (
  options: SessionOptions & {
    readonly host: string;
    readonly port?: number | undefined;
  },
) =>
  NodeSocket.makeNet({
    host: options.host,
    port: options.port ?? 9000,
    openTimeout: Duration.seconds(10),
  }).pipe(Effect.flatMap((socket) => make(socket, options)));
