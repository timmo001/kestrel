/**
 * Runs the Kestrel server inside the desktop app and reports how it's doing:
 * starting, up with how many sources are connected and cameras set to
 * record, or down. A server that stops starts again, waiting longer each
 * time up to 30 seconds.
 */
import { BunServices } from "@effect/platform-bun";
import { Server } from "@timmo001/kestrel-server";
import { Api } from "@timmo001/kestrel-server/api";
import {
  Cause,
  Context,
  Effect,
  Layer,
  Schedule,
  SubscriptionRef,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

export type Status =
  | { readonly state: "starting" }
  | {
      readonly state: "up";
      readonly connected: number;
      readonly sources: number;
      readonly recording: number;
    }
  | { readonly state: "down" };

export interface Options {
  readonly port: number;
  /** Where the built web client is. */
  readonly web: string;
}

const restart = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

/** The server running in this process, and its status as it changes. */
export class DesktopServer extends Context.Service<
  DesktopServer,
  { readonly status: SubscriptionRef.SubscriptionRef<Status> }
>()("@timmo001/kestrel-desktop/DesktopServer") {
  static readonly layer = (options: Options) =>
    Layer.effect(
      DesktopServer,
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>({
          state: "starting",
        });

        const client = yield* HttpApiClient.make(Api, {
          baseUrl: `http://127.0.0.1:${options.port}`,
        });

        const check = Effect.gen(function* () {
          yield* client.system.health();
          const sources = yield* client.sources.list();
          const settings = yield* client.sources.settings();

          return {
            state: "up",
            connected: sources.filter(({ connection }) => connection.connected)
              .length,
            sources: sources.length,
            recording: settings.recording.cameras.length,
          } satisfies Status;
        });

        // A check that fails while it's up means it stopped answering; one
        // that fails while starting is just early
        const refresh = check.pipe(
          Effect.flatMap((next) => SubscriptionRef.set(status, next)),
          Effect.catch(() =>
            SubscriptionRef.update(status, (current): Status =>
              current.state === "up" ? { state: "down" } : current,
            ),
          ),
        );

        yield* Layer.launch(
          Server.layer({
            hostname: "127.0.0.1",
            port: options.port,
            web: options.web,
          }),
        ).pipe(
          Effect.sandbox,
          Effect.tapError((cause) =>
            Effect.logError("The server stopped", Cause.pretty(cause)).pipe(
              Effect.andThen(SubscriptionRef.set(status, { state: "down" })),
            ),
          ),
          Effect.retry(restart),
          Effect.forkScoped,
        );

        // Wait for the first answer, so the window doesn't open on an error
        // page, then check every 15 seconds
        yield* check.pipe(
          Effect.retry(Schedule.spaced("250 millis")),
          Effect.timeoutOption("30 seconds"),
        );
        yield* refresh.pipe(
          Effect.repeat(Schedule.spaced("15 seconds")),
          Effect.forkScoped,
        );

        return DesktopServer.of({ status });
      }),
    ).pipe(Layer.provide([BunServices.layer, FetchHttpClient.layer]));
}
