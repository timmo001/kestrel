/**
 * Announces the server on the home network over mDNS, as `_kestrel._tcp`
 * with its id and version, so devices find it without its address. Only a
 * server listening beyond this machine announces itself, and
 * `KESTREL_ANNOUNCE=false` keeps one quiet.
 *
 * @module
 */
import { announce } from "@timmo001/kestrel-core/discovery";
import { version } from "@timmo001/kestrel-core";
import { Config, Effect, Layer } from "effect";
import { Identity, loopback } from "./Identity.ts";

export const layer = (options: {
  readonly hostname: string;
  readonly port: number;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const identity = yield* Identity;

      const enabled = yield* Config.Boolean("KESTREL_ANNOUNCE").pipe(
        Config.withDefault(true),
      );

      if (!enabled || loopback.has(options.hostname)) return;

      yield* announce({
        id: identity.id,
        name: identity.name,
        version,
        port: options.port,
      });

      yield* Effect.logInfo(
        `Announcing ${identity.name} on the network as _kestrel._tcp`,
      );
    }),
  );
