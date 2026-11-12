/**
 * Passes go2rtc through on the server's own address, under `/go2rtc/`, so
 * the web client plays live video from the same origin it was served from:
 * through a proxy, over HTTPS and from a phone, with go2rtc itself only on
 * 127.0.0.1. Plain requests are forwarded, and the player's WebSocket is
 * upgraded and piped both ways.
 *
 * @module
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

/** The path go2rtc is served under, set as its `base_path`. */
export const basePath = "/go2rtc";

/** Copies every frame from one socket to the other until either side ends. */
const pipe = (from: Socket.Socket, to: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* from.reader;
      const writer = yield* to.writer;

      for (;;) {
        const frames = yield* reader.pull;

        for (const frame of frames) yield* writer.write(frame);
      }
    }),
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

        yield* Effect.raceFirst(
          pipe(client, server),
          pipe(server, client),
        ).pipe(Effect.ignore);

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
