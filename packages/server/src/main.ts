/**
 * Starts the server. Its sources come from `sources.json` in the config
 * folder (`KESTREL_CONFIG`, else `~/.config/kestrel` or `%APPDATA%\kestrel`),
 * set up on the Settings page; without one, it's the Raysharp recorder from
 * `KESTREL_RAYSHARP_HOST`, `KESTREL_RAYSHARP_USERNAME` and
 * `KESTREL_RAYSHARP_PASSWORD`.
 */
import path from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { Server } from "./index.ts";

const main = Effect.gen(function* () {
  const hostname = yield* Config.String("KESTREL_HOST").pipe(
    Config.withDefault("127.0.0.1"),
  );

  // PORT is what Pitchfork hands its daemons
  const port = yield* Config.Int("KESTREL_PORT").pipe(
    Config.orElse(() => Config.Int("PORT")),
    Config.withDefault(7380),
  );

  const web = yield* Config.String("KESTREL_WEB").pipe(
    Config.withDefault(path.resolve(import.meta.dir, "../../web/dist")),
  );

  return yield* Layer.launch(Server.layer({ hostname, port, web }));
});

BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
