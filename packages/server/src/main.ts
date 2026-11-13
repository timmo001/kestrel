/**
 * Starts the server, as `mise run serve:server` does, set from the
 * environment (see `Server.fromEnvironment`). Its sources come from
 * `sources.json` in the config folder (`KESTREL_CONFIG`, else
 * `~/.config/kestrel` or `%APPDATA%\kestrel`), set up on the Settings page;
 * without one, it's the Raysharp recorder from `KESTREL_RAYSHARP_HOST`,
 * `KESTREL_RAYSHARP_USERNAME` and `KESTREL_RAYSHARP_PASSWORD`.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Server } from "./index.ts";

BunRuntime.runMain(
  Layer.launch(Layer.unwrap(Server.fromEnvironment)).pipe(
    Effect.provide(BunServices.layer),
  ),
);
