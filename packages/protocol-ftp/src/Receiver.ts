/**
 * An upload-only FTP server, for cameras that send their clips by FTP. Each
 * login is checked by the caller, and each file a camera stores is handed
 * over as a stream of its bytes as they arrive. It lists nothing, hands
 * nothing back and deletes nothing: folders exist as soon as they're named,
 * and listings come back empty. Data goes over passive connections only, on
 * a small range of ports, and a data connection must come from the same
 * address as its login.
 *
 * @module
 */
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Redacted,
  Scope,
  Stream,
} from "effect";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import type * as SocketServer from "effect/socket/SocketServer";

/** A file a camera is storing. */
export interface Upload {
  /** The login it came in on. */
  readonly user: string;
  /** Its path from the root, such as `/clips/Front Door_00_20260713123456.mp4`. */
  readonly path: string;
  /** The address it came from. */
  readonly from: string;
  /** Its bytes as they arrive, ending when the camera closes the connection. */
  readonly data: Stream.Stream<Uint8Array, Socket.SocketError>;
}

export interface ReceiverOptions<E, R> {
  /** The port for logins, or 0 for any. */
  readonly port: number;
  /** The address to listen on; every address when left out. */
  readonly host?: string | undefined;
  /** The ports data connections may use, such as 7390 to 7399. */
  readonly passive: { readonly from: number; readonly to: number };
  /** Whether a login's password is right. */
  readonly check: (
    user: string,
    password: Redacted.Redacted,
  ) => Effect.Effect<boolean, never, R>;
  /** Takes a file as it arrives; reads `data` to its end. A failure tells the camera the file wasn't kept. */
  readonly receive: (upload: Upload) => Effect.Effect<void, E, R>;
}

export interface Receiver {
  /** The port it takes logins on. */
  readonly port: number;
}

/** The longest a control connection may sit with nothing said. */
const idle = Duration.minutes(5);

/** How long to wait for a camera to open the data connection it asked for. */
const connecting = Duration.seconds(30);

/** The longest one file may take. */
const longest = Duration.hours(1);

/** The longest command line taken, well past any real one. */
const longestLine = 4096;

const features = ["211-Features:", " EPSV", " PASV", " UTF8", "211 End"];

/** An address as a camera sees it, without the IPv4-in-IPv6 prefix. */
const plain = (address: string | undefined) =>
  address?.startsWith("::ffff:") === true ? address.slice(7) : address;

/** A path resolved against the folder it's named from, never above the root. */
export const resolve = (folder: string, name: string) => {
  const parts: Array<string> = [];

  for (const part of `${name.startsWith("/") ? "" : folder}/${name}`.split(
    "/",
  )) {
    if (part === "" || part === ".") continue;

    if (part === "..") parts.pop();
    else parts.push(part);
  }

  return `/${parts.join("/")}`;
};

/** A command line split into its verb and what follows. */
export const parse = (line: string) => {
  const space = line.indexOf(" ");

  return space === -1
    ? { verb: line.toUpperCase(), argument: "" }
    : {
        verb: line.slice(0, space).toUpperCase(),
        argument: line.slice(space + 1),
      };
};

/** An end of the connection that isn't a failure. */
const closedCleanly = (error: Socket.SocketError) =>
  Predicate.isTagged(error.reason, "SocketCloseError") &&
  error.reason.code === 1000;

/** A passive listener, waiting for its one data connection. */
interface Passive {
  readonly port: number;
  readonly scope: Scope.Closeable;
  readonly accepted: Deferred.Deferred<Socket.Socket>;
  readonly finished: Deferred.Deferred<void>;
}

/** Opens a passive listener on the first free port in the range, taking only a connection from `peer`. */
const openPassive = Effect.fnUntraced(function* (
  range: { readonly from: number; readonly to: number },
  host: string | undefined,
  peer: string | undefined,
) {
  for (let port = range.from; port <= range.to; port++) {
    const scope = yield* Scope.make();

    const opened = yield* NodeSocketServer.make(
      host === undefined ? { port } : { port, host },
    ).pipe(Scope.provide(scope), Effect.option);

    if (Option.isNone(opened)) {
      yield* Scope.close(scope, Exit.void);
      continue;
    }

    const accepted = yield* Deferred.make<Socket.Socket>();
    const finished = yield* Deferred.make<void>();

    yield* opened.value
      .run((socket) =>
        Effect.gen(function* () {
          const conn = yield* Effect.serviceOption(NodeSocket.NetSocket);

          const from = Option.match(conn, {
            onNone: () => undefined,
            onSome: (each) => plain(each.remoteAddress),
          });

          // Only the camera that asked, and only once
          if (from !== peer) return;

          if (!(yield* Deferred.succeed(accepted, socket))) return;

          yield* Deferred.await(finished);
        }),
      )
      .pipe(Effect.forkIn(scope));

    return Option.some<Passive>({ port, scope, accepted, finished });
  }

  return Option.none<Passive>();
});

/** One camera's control connection, from its greeting to its goodbye. */
const session = <E, R>(options: ReceiverOptions<E, R>, socket: Socket.Socket) =>
  Effect.gen(function* () {
    const conn = yield* Effect.serviceOption(NodeSocket.NetSocket);
    const local = Option.getOrUndefined(conn)?.localAddress;
    const peer = plain(Option.getOrUndefined(conn)?.remoteAddress);
    const pull = yield* Socket.readerBytes(socket);
    const writer = yield* socket.writer;
    const decoder = new TextDecoder();

    const reply = (...lines: ReadonlyArray<string>) =>
      writer.write(lines.map((line) => `${line}\r\n`).join(""));

    let buffered = "";
    let user: string | undefined;
    let loggedIn = false;
    let folder = "/";
    let passive: Passive | undefined;

    const closePassive = Effect.suspend(() => {
      const open = passive;

      passive = undefined;

      return open === undefined
        ? Effect.void
        : Deferred.succeed(open.finished, undefined).pipe(
            Effect.andThen(Scope.close(open.scope, Exit.void)),
          );
    });

    yield* Effect.addFinalizer(() => closePassive);

    /** The next command line, or none once the camera's gone or quiet too long. */
    const nextLine: Effect.Effect<Option.Option<string>> = Effect.gen(
      function* () {
        for (;;) {
          const end = buffered.indexOf("\n");

          if (end !== -1) {
            const line = buffered.slice(0, end).replace(/\r$/, "");

            buffered = buffered.slice(end + 1);

            return Option.some(line);
          }

          if (buffered.length > longestLine) return Option.none();

          const chunks = yield* pull.pipe(Effect.timeout(idle), Effect.option);

          if (Option.isNone(chunks)) return Option.none();

          for (const chunk of chunks.value) {
            buffered += decoder.decode(chunk, { stream: true });
          }
        }
      },
    );

    /** Runs `use` over the data connection a PASV or EPSV opened, then says how it went. */
    const transfer = <A, E2>(
      use: (data: Socket.Socket) => Effect.Effect<A, E2, R>,
    ) =>
      Effect.gen(function* () {
        const open = passive;

        if (open === undefined) {
          return yield* reply("425 Use PASV or EPSV first");
        }

        const data = yield* Deferred.await(open.accepted).pipe(
          Effect.timeout(connecting),
          Effect.option,
        );

        if (Option.isNone(data)) {
          yield* closePassive;

          return yield* reply("425 No data connection came");
        }

        yield* reply("150 Ready");

        const result = yield* use(data.value).pipe(
          Effect.timeout(longest),
          Effect.exit,
        );

        yield* closePassive;

        yield* Exit.isSuccess(result)
          ? reply("226 Done")
          : reply("451 Not kept");
      });

    /** Opens a passive listener in place of any before it, and answers with its port. */
    const listen = (answer: (port: number) => string) =>
      Effect.gen(function* () {
        yield* closePassive;

        const opened = yield* openPassive(options.passive, options.host, peer);

        if (Option.isNone(opened)) {
          return yield* reply("425 No data port free");
        }

        passive = opened.value;

        return yield* reply(answer(opened.value.port));
      });

    yield* reply("220 Kestrel");

    for (;;) {
      const line = yield* nextLine;

      if (Option.isNone(line)) return;

      const { verb, argument } = parse(line.value);

      if (verb === "QUIT") return yield* reply("221 Bye");

      if (verb === "USER") {
        user = argument;
        loggedIn = false;
        yield* reply("331 Password please");
        continue;
      }

      if (verb === "PASS") {
        loggedIn =
          user !== undefined &&
          (yield* options.check(user, Redacted.make(argument)));

        yield* loggedIn ? reply("230 Logged in") : reply("530 Wrong login");
        continue;
      }

      switch (verb) {
        case "SYST":
          yield* reply("215 UNIX Type: L8");
          continue;
        case "FEAT":
          yield* reply(...features);
          continue;
        case "OPTS":
        case "NOOP":
          yield* reply("200 OK");
          continue;
        case "AUTH":
          yield* reply("502 Plain FTP only");
          continue;
        default:
          break;
      }

      if (!loggedIn || user === undefined) {
        yield* reply("530 Log in first");
        continue;
      }

      switch (verb) {
        case "TYPE":
        case "MODE":
        case "STRU":
          yield* reply("200 OK");
          break;
        case "ALLO":
          yield* reply("202 No need");
          break;
        case "PWD":
        case "XPWD":
          yield* reply(`257 "${folder.replaceAll('"', '""')}"`);
          break;
        case "CWD":
        case "XCWD":
          folder = resolve(folder, argument);
          yield* reply("250 OK");
          break;
        case "CDUP":
        case "XCUP":
          folder = resolve(folder, "..");
          yield* reply("250 OK");
          break;
        case "MKD":
        case "XMKD":
          yield* reply(
            `257 "${resolve(folder, argument).replaceAll('"', '""')}" made`,
          );
          break;
        case "DELE":
        case "RMD":
        case "XRMD":
          // Nothing is kept here to delete, which is what was asked
          yield* reply("250 OK");
          break;
        case "SIZE":
        case "MDTM":
        case "RETR":
          yield* reply("550 Nothing to hand back");
          break;
        case "PASV": {
          const address = plain(local);

          if (address === undefined || !address.includes(".")) {
            yield* reply("425 Use EPSV");
            break;
          }

          yield* listen(
            (port) =>
              `227 Entering Passive Mode (${address.replaceAll(".", ",")},${Math.floor(port / 256)},${port % 256})`,
          );
          break;
        }

        case "EPSV":
          if (argument.toUpperCase() === "ALL") {
            yield* reply("200 OK");
            break;
          }

          yield* listen(
            (port) => `229 Entering Extended Passive Mode (|||${port}|)`,
          );
          break;
        case "LIST":
        case "NLST":
        case "MLSD":
          yield* transfer(() => Effect.void);
          break;
        case "STOR":
        case "APPE": {
          const path = resolve(folder, argument);
          const from = peer ?? "";
          const login = user;

          yield* transfer((data) =>
            options.receive({
              user: login,
              path,
              from,
              data: Socket.toStream(data).pipe(
                Stream.catchIf(closedCleanly, () => Stream.empty),
              ),
            }),
          );
          break;
        }

        default:
          yield* reply("502 Not here");
      }
    }
  }).pipe(Effect.scoped);

/** Listens for cameras' logins until the scope closes. */
export const serve = Effect.fnUntraced(function* <E, R>(
  options: ReceiverOptions<E, R>,
): Effect.fn.Return<Receiver, SocketServer.SocketServerError, Scope.Scope | R> {
  const server = yield* NodeSocketServer.make(
    options.host === undefined
      ? { port: options.port }
      : { port: options.port, host: options.host },
  );

  yield* server
    .run((socket) => session(options, socket))
    .pipe(Effect.forkScoped);

  return {
    port: NetAddress.isInetAddress(server.address) ? server.address.port : 0,
  };
});
