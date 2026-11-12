/**
 * One logged-in connection to a Reolink camera, hub or recorder on its own
 * protocol: it matches replies to requests, and replays recorded files as
 * the media stream they hold, which its HTTP API can't always hand over.
 * The connection logs out and closes with the scope it was opened in.
 *
 * @module
 */
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import {
  Deferred,
  Duration,
  Effect,
  Option,
  Queue,
  Redacted,
  Schema,
} from "effect";
import * as Socket from "effect/socket/Socket";
import {
  cipher,
  concat,
  digest,
  element,
  encodeFrame,
  escapeXml,
  frameDecoder,
  loginKey,
  MessageClass,
  readXml,
  scramble,
  type Cipher,
  type Frame,
} from "./Codec.ts";

/** The device turned the login down. */
export class LoginRefused extends Schema.TaggedError<LoginRefused>()(
  "LoginRefused",
  { status: Schema.Number },
) {
  override get message() {
    return `It refused the login (${this.status})`;
  }
}

/** The device sent something this client can't read. */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()(
  "ProtocolError",
  { message: Schema.String },
) {}

/** No reply came in time. */
export class RequestTimedOut extends Schema.TaggedError<RequestTimedOut>()(
  "RequestTimedOut",
  { cmd: Schema.Number },
) {
  override get message() {
    return `It didn't answer command ${this.cmd}`;
  }
}

/** The connection couldn't open, or closed. */
export class ConnectionClosed extends Schema.TaggedError<ConnectionClosed>()(
  "ConnectionClosed",
  { message: Schema.String },
) {}

/** The device turned a replay down, as older camera firmware does. */
export class ReplayRefused extends Schema.TaggedError<ReplayRefused>()(
  "ReplayRefused",
  { status: Schema.Number },
) {
  override get message() {
    return `It refused to replay the file (${this.status})`;
  }
}

export type SessionError =
  | LoginRefused
  | ProtocolError
  | RequestTimedOut
  | ConnectionClosed
  | ReplayRefused;

export interface SessionOptions {
  readonly host: string;
  /** 9000 by default. */
  readonly port?: number | undefined;
  readonly username: Redacted.Redacted;
  readonly password: Redacted.Redacted;
  /** How long to wait for each reply, 20 seconds by default. */
  readonly timeout?: Duration.Input | undefined;
}

export interface ReplayOptions {
  /** Its channel, from 0. */
  readonly channel: number;
  /** The file's full path on the device, as its HTTP `Search` names it. */
  readonly file: string;
  readonly stream?: "main" | "sub" | undefined;
  /** How long a pause ends the replay, 3 seconds by default. */
  readonly idle?: Duration.Input | undefined;
}

export interface Session {
  /** Its device type, such as `ipc` or `homehub`, and how many channels it has. */
  readonly device: { readonly type: string; readonly channels: number };
  /**
   * A recorded file, replayed from start to end as fast as the device sends
   * it, as its media stream: see `Media.decode`.
   */
  readonly replay: (
    options: ReplayOptions,
  ) => Effect.Effect<Uint8Array, SessionError>;
}

const Command = {
  login: 1,
  logout: 2,
  replay: 5,
  replayStop: 7,
} as const;

/** The channel byte for the device itself. */
const deviceChannel = 250;

/** Replays each take a channel byte of their own, as the Reolink app does. */
const firstHandle = 40;
const lastHandle = 239;

const defaultTimeout = Duration.seconds(20);
const defaultIdle = Duration.seconds(3);
const empty = new Uint8Array(0);
const encoder = new TextEncoder();
const xmlHead = '<?xml version="1.0" encoding="UTF-8" ?>';

const closedBy = (error: Socket.SocketError) =>
  new ConnectionClosed({ message: error.message });

const loginXml = (username: string, password: string) =>
  [
    xmlHead,
    "<body>",
    '<LoginUser version="1.1">',
    `<userName>${username}</userName>`,
    `<password>${password}</password>`,
    "<userVer>1</userVer>",
    "</LoginUser>",
    '<LoginNet version="1.1">',
    "<type>LAN</type>",
    "<udpPort>0</udpPort>",
    "</LoginNet>",
    "</body>",
  ].join("\n");

const logoutXml = [
  xmlHead,
  "<body>",
  '<LoginUser version="1.1">',
  "<userVer>1</userVer>",
  "</LoginUser>",
  "</body>",
].join("\n");

const replayXml = (options: ReplayOptions) => {
  const stream = options.stream ?? "main";

  return [
    xmlHead,
    "<body>",
    '<FileInfoList version="1.1">',
    "<FileInfo>",
    `<channelId>${options.channel}</channelId>`,
    `<Id>${escapeXml(options.file)}</Id>`,
    `<supportSub>${stream === "sub" ? 1 : 0}</supportSub>`,
    "<playSpeed>1</playSpeed>",
    `<streamType>${stream}Stream</streamType>`,
    "</FileInfo>",
    "</FileInfoList>",
    "</body>",
  ].join("\n");
};

/** A replay is stopped by its channel, from 1, and when its file starts. */
const stopXml = (options: ReplayOptions) => {
  const start = /_(\d{8})_(\d{6})_/.exec(options.file);

  if (start === null) return undefined;

  return [
    xmlHead,
    "<body>",
    '<FileInfoList version="1.1">',
    "<FileInfo>",
    `<channelId>${options.channel}</channelId>`,
    `<name>${String(options.channel + 1).padStart(2, "0")}${start[1]}${start[2]}</name>`,
    `<streamType>${options.stream ?? "main"}Stream</streamType>`,
    "</FileInfo>",
    "</FileInfoList>",
    "</body>",
  ].join("\n");
};

/** Logs in over an open socket. */
export const open = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  options: SessionOptions,
) {
  const timeout = options.timeout ?? defaultTimeout;

  const pull = yield* Socket.readerBytes(socket).pipe(
    Effect.mapError(closedBy),
  );

  const write = (yield* socket.writer).write;
  const pending = new Map<string, Deferred.Deferred<Frame, SessionError>>();
  const replays = new Map<number, Queue.Queue<Frame, SessionError>>();
  let aes: Cipher | undefined;
  let message = 0;
  let handle = lastHandle;
  let isOpen = true;

  const keyOf = (cmd: number, channel: number, number: number) =>
    `${cmd}:${channel}:${number}`;

  const send = (frame: Uint8Array) =>
    Effect.suspend(() => write(frame)).pipe(Effect.mapError(closedBy));

  /** XML to send: scrambled until login, encrypted after it. */
  const sealed = (xml: string, channel: number) => {
    const bytes = encoder.encode(xml);

    return aes === undefined ? scramble(bytes, channel) : aes.encrypt(bytes);
  };

  const xmlOf = (frame: Frame) =>
    readXml(frame.payload, frame.channel, aes) ||
    readXml(frame.extension, frame.channel, aes);

  /** Sends a message and waits for the reply with the same command, channel and number. */
  const request = (options: {
    readonly cmd: number;
    readonly channel?: number;
    readonly number?: number;
    readonly messageClass?: number;
    readonly status?: number;
    readonly payload: Uint8Array;
  }): Effect.Effect<Frame, SessionError> =>
    Effect.gen(function* () {
      if (!isOpen) {
        return yield* new ConnectionClosed({
          message: "The connection is closed",
        });
      }

      const channel = options.channel ?? deviceChannel;

      message = (message + 1) % 65536;

      const number = options.number ?? message;
      const key = keyOf(options.cmd, channel, number);
      const reply = yield* Deferred.make<Frame, SessionError>();

      // Registered before sending, so a fast reply can't arrive first
      pending.set(key, reply);

      return yield* send(
        encodeFrame({
          cmd: options.cmd,
          channel,
          message: number,
          status: options.status ?? 0,
          messageClass: options.messageClass ?? MessageClass.modern,
          payload: options.payload,
        }),
      ).pipe(
        Effect.andThen(Deferred.await(reply)),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new RequestTimedOut({ cmd: options.cmd })),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(key))),
      );
    });

  const dispatch = (frame: Frame) => {
    const replay =
      frame.cmd === Command.replay ? replays.get(frame.channel) : undefined;

    if (replay !== undefined) {
      return Queue.offer(replay, frame).pipe(Effect.asVoid);
    }

    const waiting = pending.get(keyOf(frame.cmd, frame.channel, frame.message));

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

        if (problem !== undefined) {
          return yield* new ProtocolError({ message: problem });
        }
      }
    }
  });

  yield* readLoop.pipe(
    Effect.catch((error: SessionError) =>
      Effect.gen(function* () {
        isOpen = false;

        for (const waiting of pending.values()) {
          yield* Deferred.fail(waiting, error);
        }

        for (const replay of replays.values()) yield* Queue.fail(replay, error);
        pending.clear();
      }),
    ),
    Effect.forkScoped,
  );

  // The nonce comes first, on the old message class, then the login itself
  const hello = yield* request({
    cmd: Command.login,
    messageClass: MessageClass.legacy,
    status: 0xdc12,
    payload: empty,
  });

  const nonce = element(xmlOf(hello), "nonce");

  if (nonce === undefined) {
    return yield* new ProtocolError({ message: "It didn't send a nonce" });
  }

  const username = Redacted.value(options.username);
  const password = Redacted.value(options.password);

  const login = yield* request({
    cmd: Command.login,
    payload: sealed(
      loginXml(digest(`${username}${nonce}`), digest(`${password}${nonce}`)),
      deviceChannel,
    ),
  });

  if (login.status !== 200) {
    return yield* new LoginRefused({ status: login.status });
  }

  aes = cipher(loginKey(nonce, password));

  const info = xmlOf(login);

  yield* Effect.addFinalizer(() =>
    send(
      encodeFrame({
        cmd: Command.logout,
        channel: deviceChannel,
        message: 0,
        messageClass: MessageClass.modern,
        payload: sealed(logoutXml, deviceChannel),
      }),
    ).pipe(Effect.ignore),
  );

  /** A media message's bytes, the first `encryptLen` of them decrypted where it says so. */
  const mediaOf = (frame: Frame) => {
    const length = Number(
      element(readXml(frame.extension, frame.channel, aes), "encryptLen") ?? 0,
    );

    if (length <= 0 || aes === undefined) return frame.payload;

    const cut = Math.min(length, frame.payload.length);

    return concat(
      aes.decrypt(frame.payload.subarray(0, cut)),
      frame.payload.subarray(cut),
    );
  };

  const nextHandle = () => {
    handle = handle >= lastHandle ? firstHandle : handle + 1;

    return handle;
  };

  const replay: Session["replay"] = (options) =>
    Effect.gen(function* () {
      const id = nextHandle();
      const queue = yield* Queue.unbounded<Frame, SessionError>();

      replays.set(id, queue);

      const stop = stopXml(options);

      const stopped = Effect.gen(function* () {
        replays.delete(id);

        if (stop !== undefined) {
          yield* request({
            cmd: Command.replayStop,
            channel: nextHandle(),
            number: 0,
            payload: sealed(stop, id),
          }).pipe(Effect.ignore);
        }
      });

      return yield* Effect.gen(function* () {
        yield* send(
          encodeFrame({
            cmd: Command.replay,
            channel: id,
            message: 0,
            messageClass: MessageClass.modern,
            payload: sealed(replayXml(options), id),
          }),
        );

        const first = yield* Queue.take(queue).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(new RequestTimedOut({ cmd: Command.replay })),
          }),
        );

        if (first.status !== 200) {
          return yield* new ReplayRefused({ status: first.status });
        }

        const chunks = [mediaOf(first)];

        // Nothing marks the end, so a pause does, or a 201 where firmware sends one
        for (;;) {
          const next = yield* Queue.take(queue).pipe(
            Effect.timeoutOption(options.idle ?? defaultIdle),
          );

          if (Option.isNone(next)) break;

          chunks.push(mediaOf(next.value));

          if (next.value.status === 201) break;
        }

        return concat(...chunks);
      }).pipe(Effect.ensuring(stopped));
    });

  return {
    device: {
      type: element(info, "type") ?? "",
      channels: Number(element(info, "channelNum") ?? 1),
    },
    replay,
  } satisfies Session;
});

/** Opens a connection to a device's own port, 9000 by default, and logs in. */
export const connect = (options: SessionOptions) =>
  NodeSocket.makeNet({
    host: options.host,
    port: options.port ?? 9000,
    openTimeout: Duration.seconds(10),
  }).pipe(Effect.flatMap((socket) => open(socket, options)));
