/**
 * Passes go2rtc through on the server's own address, under `/go2rtc/`, so
 * the web client plays live video from the same origin it was served from:
 * through a proxy, over HTTPS and from a phone, with go2rtc itself only on
 * 127.0.0.1. Plain requests are forwarded, and the player's WebSocket is
 * upgraded and piped both ways. Once the player goes, its stream is held
 * open for a little while, reading and dropping what go2rtc sends, so a page
 * loading again finds the camera already connected rather than waiting for
 * go2rtc to reach it again.
 *
 * @module
 */
import { Duration, Effect, Exit, Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

/** The path go2rtc is served under, set as its `base_path`. */
export const basePath = "/go2rtc";

/** How long a stream is held open once its player goes. */
const linger = Duration.seconds(30);

/** Copies every frame from a reader to a socket until either side ends. */
const forward = (reader: Socket.Reader, to: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* to.writer;

      for (;;) {
        const frames = yield* reader.pull;

        for (const frame of frames) yield* writer.write(frame);
      }
    }),
  );

/** Copies every frame from one socket to the other until either side ends. */
const pipe = (from: Socket.Socket, to: Socket.Socket) =>
  Effect.scoped(
    from.reader.pipe(Effect.flatMap((reader) => forward(reader, to))),
  );

/** Reads and drops what go2rtc sends for `linger`, then closes it. */
const hold = (reader: Socket.Reader, scope: Scope.Closeable) =>
  Effect.forever(reader.pull).pipe(
    Effect.timeout(linger),
    Effect.ignore,
    Effect.ensuring(Scope.close(scope, Exit.void)),
  );

const unavailable = HttpServerResponse.text("go2rtc isn't answering", {
  status: 502,
});

/** The `/go2rtc/*` routes, for a go2rtc listening on 127.0.0.1 at `port`. */
export const routes = (port: number) =>
  HttpRouter.add("*", `${basePath}/*`, (request) =>
    Effect.gen(function* () {
      const url = new URL(request.url, "http://localhost");
      const upstream = `127.0.0.1:${port}${url.pathname}${url.search}`;

      if (request.headers.upgrade?.toLowerCase() === "websocket") {
        const client = yield* request.upgrade;

        const server = yield* Socket.makeWebSocket(`ws://${upstream}`).pipe(
          Effect.provide(Socket.layerWebSocketConstructorGlobal),
        );

        // go2rtc's side opens in a scope of its own, so it can outlive the player
        const held = yield* Scope.make();

        const fromServer = yield* server.reader.pipe(
          Scope.provide(held),
          Effect.onError(() => Scope.close(held, Exit.void)),
        );

        yield* Effect.raceFirst(
          pipe(client, server),
          forward(fromServer, client),
        ).pipe(
          Effect.ignore,
          Effect.ensuring(Effect.forkDetach(hold(fromServer, held))),
        );

        return HttpServerResponse.empty();
      }

      const response = yield* Effect.tryPromise(() =>
        fetch(`http://${upstream}`, {
          method: request.method,
          headers: { accept: request.headers.accept ?? "*/*" },
        }),
      );

      return HttpServerResponse.fromWeb(response);
    }).pipe(Effect.catch(() => Effect.succeed(unavailable))),
  );
