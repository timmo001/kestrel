/**
 * The Kestrel server the desktop app uses, and how it's doing. It's either
 * this computer's own, run inside the app, which reports starting, up with
 * how many sources are connected and cameras set to record, or down, and
 * starts again when it stops, waiting longer each time up to 30 seconds. Or
 * it's another server the app is paired with, which reports up, out of
 * reach, unpaired or on another version; one that's moved is found again by
 * its id. Either way it gives the address that signs the window in.
 */
import { BunServices } from "@effect/platform-bun";
import { version, versionHeader } from "@timmo001/kestrel-core";
import { browse } from "@timmo001/kestrel-core/discovery";
import { Server, Sources } from "@timmo001/kestrel-server";
import { Api } from "@timmo001/kestrel-server/api";
import { ownerTokenFile } from "@timmo001/kestrel-server/folders";
import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  SubscriptionRef,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";

import type { Connection, Remote } from "./connection.ts";

export type Status =
  | { readonly state: "starting" }
  | {
      readonly state: "up";
      readonly connected: number;
      readonly sources: number;
      readonly recording: number;
    }
  | { readonly state: "down" }
  | { readonly state: "remote"; readonly name: string }
  | { readonly state: "unreachable"; readonly name: string }
  | { readonly state: "unpaired"; readonly name: string }
  /** The server runs `server`, not this app's version. */
  | {
      readonly state: "mismatch";
      readonly name: string;
      readonly server: string;
    };

export interface Options {
  readonly port: number;
  /** Where the built web client is. */
  readonly web: string;
  readonly connection: Connection;
  /** Called with where a paired server is now, when it's moved. */
  readonly moved: (connection: Remote) => void;
}

const restart = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

/** A client for `baseUrl`, saying this app's version, signed in with `token` where there's one. */
export const clientFor = (
  baseUrl: string,
  token: Option.Option<Redacted.Redacted>,
) =>
  HttpApiClient.make(Api, {
    baseUrl,
    transformClient: (client) =>
      Option.match(token, {
        onNone: () => client,
        onSome: (bearer) =>
          HttpClient.mapRequest(client, HttpClientRequest.bearerToken(bearer)),
      }).pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeader(versionHeader, version),
        ),
      ),
  });

const isUnreachable = (error: Error) =>
  HttpClientError.isHttpClientError(error) &&
  Predicate.isTagged(error.reason, "TransportError");

const isUnpaired = (error: Error) =>
  HttpClientError.isHttpClientError(error) && error.response?.status === 401;

/** The server the app uses, its status as it changes, and how to sign its window in. */
export class DesktopServer extends Context.Service<
  DesktopServer,
  {
    readonly status: SubscriptionRef.SubscriptionRef<Status>;
    /** Where the page comes from. */
    readonly origin: string;
    /**
     * The address to open the window at: the page, signed in where it needs
     * to be, or nothing while the server can't sign it in.
     */
    readonly signIn: Effect.Effect<Option.Option<string>>;
  }
>()("@timmo001/kestrel-desktop/DesktopServer") {
  static readonly layer = (options: Options) =>
    Layer.effect(
      DesktopServer,
      options.connection.mode === "remote"
        ? remote(options.connection, options.moved)
        : local(options, options.connection.share),
    ).pipe(Layer.provide([BunServices.layer, FetchHttpClient.layer]));
}

/** This computer's server, run here: on this computer alone, or on the network with `share`. */
const local = (options: Options, share: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const origin = `http://127.0.0.1:${options.port}`;

    const status = yield* SubscriptionRef.make<Status>({
      state: "starting",
    });

    const client = yield* clientFor(origin, Option.none());

    // The running server's sources, read in this process rather than over
    // HTTP, so checking them doesn't fill its request log
    const running = yield* Ref.make(Option.none<Sources["Service"]>());

    const check = Effect.gen(function* () {
      yield* client.system.health();

      const sources = yield* Ref.get(running).pipe(
        Effect.flatMap(Effect.fromOption),
      );

      const all = yield* sources.all;

      const connections = yield* Effect.forEach(
        all,
        (source) => source.connection,
      );

      const settings = yield* sources.settings;

      return {
        state: "up",
        connected: connections.filter(({ connected }) => connected).length,
        sources: all.length,
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

    yield* Layer.build(
      Server.layer({
        // Shared, it listens on the network, where pairing guards it
        hostname: share ? "::" : "127.0.0.1",
        port: options.port,
        web: options.web,
      }),
    ).pipe(
      Effect.flatMap((context) =>
        Ref.set(running, Option.some(Context.get(context, Sources))),
      ),
      Effect.andThen(Effect.never),
      Effect.ensuring(Ref.set(running, Option.none())),
      Effect.scoped,
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
      Effect.flatMap((first) =>
        Option.match(first, {
          onNone: () => Effect.void,
          onSome: (next) => SubscriptionRef.set(status, next),
        }),
      ),
    );
    yield* refresh.pipe(
      Effect.repeat(Schedule.spaced("15 seconds")),
      Effect.forkScoped,
    );

    // On this computer alone, the server trusts this computer. Shared, it
    // doesn't, so the window signs in as the owner, with the owner token
    // only this user can read.
    const signIn = share
      ? fs.readFileString(yield* ownerTokenFile).pipe(
          Effect.flatMap((token) =>
            clientFor(origin, Option.some(Redacted.make(token.trim()))),
          ),
          Effect.flatMap((owner) => owner.devices.link()),
          Effect.map(({ path }) => Option.some(`${origin}/${path}`)),
          Effect.catch((error) =>
            Effect.logWarning(
              `Couldn't sign the window in: ${error.message}`,
            ).pipe(Effect.as(Option.some(`${origin}/`))),
          ),
          Effect.provideService(HttpClient.HttpClient, http),
        )
      : Effect.succeed(Option.some(`${origin}/`));

    return DesktopServer.of({ status, origin, signIn });
  });

/** A server elsewhere this app is paired with. */
const remote = (connection: Remote, moved: (next: Remote) => void) =>
  Effect.gen(function* () {
    const { name } = connection;
    const status = yield* SubscriptionRef.make<Status>({ state: "starting" });

    const client = yield* clientFor(
      connection.server,
      Option.some(Redacted.make(connection.token)),
    );

    // Its info answers any version, and the device list only a paired one
    const check = Effect.gen(function* () {
      const info = yield* client.devices.server();

      if (info.version !== version) {
        return {
          state: "mismatch",
          name,
          server: info.version,
        } satisfies Status;
      }

      yield* client.devices.list();

      return { state: "remote", name } satisfies Status;
    });

    // Not at its saved address any more, such as after its router gave it a
    // new one: find it by its id, and use it where it is now
    const refind = browse("3 seconds").pipe(
      Effect.map((found) =>
        found.find(
          (each) =>
            each.id === connection.serverId && each.url !== connection.server,
        ),
      ),
      Effect.flatMap((found) =>
        found === undefined
          ? Effect.void
          : Effect.sync(() =>
              moved({
                mode: "remote",
                server: found.url,
                serverId: connection.serverId,
                name: connection.name,
                token: connection.token,
              }),
            ),
      ),
    );

    const refresh = check.pipe(
      Effect.catch((error) =>
        isUnreachable(error)
          ? refind.pipe(Effect.as<Status>({ state: "unreachable", name }))
          : Effect.succeed<Status>(
              isUnpaired(error)
                ? { state: "unpaired", name }
                : { state: "unreachable", name },
            ),
      ),
      Effect.flatMap((next) => SubscriptionRef.set(status, next)),
    );

    yield* refresh;
    yield* refresh.pipe(
      Effect.repeat(Schedule.spaced("15 seconds")),
      Effect.forkScoped,
    );

    const signIn = client.devices.link().pipe(
      Effect.map(({ path }) => Option.some(`${connection.server}/${path}`)),
      Effect.catch((error) =>
        Effect.logWarning(`Couldn't sign the window in: ${error.message}`).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );

    return DesktopServer.of({
      status,
      origin: connection.server,
      signIn,
    });
  });
