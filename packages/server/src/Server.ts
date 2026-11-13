/**
 * The HTTP server: the API's routes, go2rtc under `/go2rtc/`, the push
 * contract and the built web client, over plain HTTP, with the sources
 * behind them. Everything but the page's files and pairing needs a paired
 * device.
 *
 * @module
 */
import { BunHttpServer } from "@effect/platform-bun";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  mismatchMessage,
  version,
  versionHeader,
} from "@timmo001/kestrel-core";
import {
  connectPath,
  sessionCookie,
  Unpaired,
  VersionMismatch,
} from "./Api.ts";
import * as Announce from "./Announce.ts";
import { Attention } from "./Attention.ts";
import { cookieOptions, Devices, tokenOf } from "./Devices.ts";
import { Go2rtc } from "./go2rtc/Go2rtc.ts";
import * as Proxy from "./go2rtc/Proxy.ts";
import { routes } from "./Handlers.ts";
import { Identity, loopback } from "./Identity.ts";
import { Library } from "./Library.ts";
import { Push } from "./Push.ts";
import * as Recording from "./Recording.ts";
import { Sources } from "./Sources.ts";
import * as Sync from "./Sync.ts";

/**
 * The built web client from `directory`. A path outside the API that names a
 * file gets that file, and any other gets the page, which the service worker
 * and the page's own links work from.
 */
const webClient = (directory: string) =>
  HttpRouter.add("GET", "/*", (request) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pathname = new URL(request.url, "http://localhost").pathname;

      if (pathname === "/api" || pathname.startsWith("/api/")) {
        return HttpServerResponse.empty({ status: 404 });
      }

      const file = path.join(directory, path.normalize(pathname));

      const isFile =
        file.startsWith(`${directory}${path.sep}`) &&
        (yield* fs.stat(file).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        ));

      // Checked with the browser each time, by ETag, so a new build reaches
      // the page and its service worker at once rather than when the
      // browser's own guess at freshness runs out
      return yield* HttpServerResponse.file(
        isFile ? file : path.join(directory, "index.html"),
      ).pipe(
        Effect.map(HttpServerResponse.setHeader("cache-control", "no-cache")),
      );
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          HttpServerResponse.text(
            "The web client isn't built. Run `mise run build`.",
            { status: 503 },
          ),
        ),
      ),
    ),
  );

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
  /** Where the built web client is. */
  readonly web: string;
}

/** go2rtc under `/go2rtc/`, at the port the `Go2rtc` service runs it on. */
const go2rtc = Layer.unwrap(
  Effect.gen(function* () {
    return Proxy.routes((yield* Go2rtc).port);
  }),
);

/** The push contract's routes, from the `Push` service. */
const push = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Push).routes;
  }),
);

/** The paths that need a paired device: the API, go2rtc and push. */
const guarded = (path: string) =>
  ["/api/", "/go2rtc/", "/push/"].some((start) => path.startsWith(start));

/** The paths open to anyone, so a device can find the server and pair. */
const open = new Set([
  "/api/health",
  "/api/devices/server",
  "/api/devices/pair",
]);

const unpaired = HttpServerResponse.jsonUnsafe(
  Schema.encodeSync(Unpaired)(
    new Unpaired({ message: "Pair this device with the server first" }),
  ),
  { status: 401 },
);

/** The paths open to any version, so a client can always learn the server's. */
const anyVersion = new Set(["/api/health", "/api/devices/server"]);

const mismatched = (client: string) =>
  HttpServerResponse.jsonUnsafe(
    Schema.encodeSync(VersionMismatch)(
      new VersionMismatch({
        message: mismatchMessage({
          client,
          server: version,
          what: "This client",
          where: "this address",
        }),
        server: version,
        client,
      }),
    ),
    { status: 426 },
  );

/**
 * Lets a request through to the API, go2rtc or push only from a paired
 * device, by its bearer token or its window's cookie, and only from a client
 * of the server's own version where it says its version. The page's own
 * files stay open, so a browser that isn't paired can load the pairing page.
 *
 * With `trustLoopback`, set only while the server listens on this machine
 * alone, a request from this machine needs nothing. Once it listens on the
 * network, a request from this machine needs a token too, since other
 * users, or apps sharing the host's network, would reach it that way.
 */
const signIn =
  (options: { readonly trustLoopback: boolean }) =>
  <E, R>(
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://kestrel").pathname;

      // A video, events stream or socket can't send a header, so only a
      // client that says its version is held to it
      const client = request.headers[versionHeader];

      if (
        client !== undefined &&
        client !== version &&
        guarded(path) &&
        !anyVersion.has(path)
      ) {
        return mismatched(client);
      }

      if (
        !guarded(path) ||
        open.has(path) ||
        (options.trustLoopback &&
          Option.exists(request.remoteAddress, (remote) =>
            loopback.has(remote),
          ))
      ) {
        return yield* httpEffect;
      }

      const token = tokenOf(request);
      const devices = yield* Devices;

      const signedIn =
        token === undefined
          ? Option.none()
          : yield* devices.authenticate(token);

      return Option.isSome(signedIn) ? yield* httpEffect : unpaired;
    });

/**
 * A one-time sign-in link, such as the desktop app opens for its window:
 * sets the window's cookie as the device that asked for it, then goes to the
 * page.
 */
const connect = HttpRouter.add("GET", `/${connectPath}*`, (request) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const path = new URL(request.url, "http://kestrel").pathname;
    const code = path.slice(`/${connectPath}`.length);

    return yield* devices.connect(code).pipe(
      Effect.map((session) =>
        // From /auth/connect/<code>, `../../` is the page's root, under
        // whichever path it's served from
        HttpServerResponse.redirect("../../").pipe(
          HttpServerResponse.setCookieUnsafe(
            sessionCookie,
            session,
            cookieOptions(request),
          ),
        ),
      ),
      Effect.catchTag("PairingRefused", (refused) =>
        Effect.succeed(
          HttpServerResponse.text(refused.message, { status: 403 }),
        ),
      ),
    );
  }),
);

/**
 * The server as `kestrel serve` and `mise run serve:server` run it, set from
 * the environment: `KESTREL_HOST`, all addresses (`::`) by default, so other
 * devices reach it once paired; `KESTREL_PORT` or `PORT`, 7380 by default;
 * and `KESTREL_WEB`, the built web client, `packages/web/dist` beside this
 * package by default.
 */
export const fromEnvironment = Effect.gen(function* () {
  const path = yield* Path.Path;

  const hostname = yield* Config.String("KESTREL_HOST").pipe(
    Config.withDefault("::"),
  );

  // PORT is what Pitchfork hands its daemons
  const port = yield* Config.Int("KESTREL_PORT").pipe(
    Config.orElse(() => Config.Int("PORT")),
    Config.withDefault(7380),
  );

  const web = yield* Config.String("KESTREL_WEB").pipe(
    Config.withDefault(path.resolve(import.meta.dir, "../../web/dist")),
  );

  return layer({ hostname, port, web });
});

/**
 * Serves the API and the web client over plain HTTP, with the sources behind
 * it. The sources stay in what it provides, for a host in the same process,
 * such as the desktop app, to read without going through HTTP.
 */
export const layer = (options: ServeOptions) =>
  HttpRouter.serve(
    Layer.mergeAll(routes, go2rtc, push, connect, webClient(options.web)),
    { middleware: signIn({ trustLoopback: loopback.has(options.hostname) }) },
  ).pipe(
    Layer.provide(
      BunHttpServer.layer({
        hostname: options.hostname,
        port: options.port,
        // The page's live events and go2rtc's sockets never finish, so the
        // default 20 seconds for open requests held up every stop with a
        // page open
        gracefulShutdownTimeout: "2 seconds",
      }),
    ),
    Layer.merge(Recording.layer),
    Layer.merge(Sync.layer),
    Layer.merge(Announce.layer(options)),
    Layer.provide([Go2rtc.layer, Attention.layer, Library.layer]),
    Layer.provide(Push.layer),
    // One `Devices` for the routes and the sign-in check, so a code made by
    // one is known to the other
    Layer.provide(Devices.layer),
    Layer.provide(Identity.layer(options)),
    // Last, so the routes and go2rtc share one connection to each source.
    Layer.provideMerge(Sources.layer),
  );
