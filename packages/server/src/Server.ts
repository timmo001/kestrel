/**
 * The HTTP server: the API's routes, go2rtc under `/go2rtc/`, the push
 * contract and the built web client, over plain HTTP, with the sources
 * behind them.
 *
 * @module
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Attention } from "./Attention.ts";
import { Go2rtc } from "./go2rtc/Go2rtc.ts";
import * as Proxy from "./go2rtc/Proxy.ts";
import { routes } from "./Handlers.ts";
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

/** Serves the API and the web client over plain HTTP, with the sources behind it. */
export const layer = (options: ServeOptions) =>
  HttpRouter.serve(
    Layer.mergeAll(routes, go2rtc, push, webClient(options.web)),
  ).pipe(
    Layer.provide(
      BunHttpServer.layer({ hostname: options.hostname, port: options.port }),
    ),
    Layer.merge(Recording.layer),
    Layer.merge(Sync.layer),
    Layer.provide([Go2rtc.layer, Attention.layer, Library.layer]),
    Layer.provide(Push.layer),
    // Last, so the routes and go2rtc share one connection to each source.
    Layer.provide(Sources.layer),
  );
