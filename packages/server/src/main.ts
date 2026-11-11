/**
 * Starts the server. The recorder's address and login come from the
 * environment: `DVR_HOST`, `DVR_USERNAME` and `DVR_PASSWORD`, with
 * `DVR_PORT` and `DVR_RTSP_PORT` when they aren't the defaults.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { Server } from "./index.ts";

const main = Effect.gen(function* () {
  const hostname = yield* Config.String("DVR_REVIVAL_HOST").pipe(
    Config.withDefault("127.0.0.1"),
  );

  const port = yield* Config.Int("PORT").pipe(Config.withDefault(7380));

  return yield* Layer.launch(Server.layer({ hostname, port }));
});

BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
