/**
 * Serves the docs site built into the app on 127.0.0.1, at a port the
 * system picks, so they read offline. They're the site's own build, which
 * links from `/`, so they get an origin of their own rather than a path on
 * the server.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpStaticServer } from "effect/http";

/** Where the docs are served. */
export class DesktopDocs extends Context.Service<
  DesktopDocs,
  { readonly url: string }
>()("@timmo001/kestrel-desktop/DesktopDocs") {
  /** Serves the built docs site in `root`. */
  static readonly layer = (root: string) =>
    Layer.effect(
      DesktopDocs,
      HttpServer.addressFormattedWith((url) =>
        Effect.succeed(DesktopDocs.of({ url })),
      ),
    ).pipe(
      Layer.merge(
        HttpRouter.serve(HttpStaticServer.layer({ root }), {
          disableLogger: true,
        }),
      ),
      Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
    );
}
