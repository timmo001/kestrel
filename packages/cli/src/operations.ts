/**
 * The operations the CLI and MCP server share, and the `ServerClient` they
 * run through: the server's API, at the server and with the token
 * `connection.ts` finds. Every operation only reads from the sources;
 * `download` writes a file on this machine and `pair` saves a token, so
 * they're marked as writes and are CLI-only. Cameras are named by id, such
 * as `swann/3`.
 *
 * @module
 */
import { CameraId, cameraId, type SourceInfo } from "@timmo001/kestrel-core";
import { Api } from "@timmo001/kestrel-server/api";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { connection } from "./connection.ts";

/** The server couldn't be reached or couldn't reach a source, or the input doesn't read. */
export class ClientError extends Schema.TaggedError<ClientError>()(
  "ClientError",
  { message: Schema.String },
) {}

/** How an agent may use an operation: `write` saves a file on this machine. */
export type Access = "read" | "write";

export interface Operation {
  readonly name: string;
  readonly description: string;
  readonly access: Access;
}

export const operations: ReadonlyArray<Operation> = [
  {
    name: "status",
    description:
      "What needs you, and each source's connection, clock, storage and cameras",
    access: "read",
  },
  {
    name: "details",
    description:
      "A source's details: its facts, clock, storage and each camera's state",
    access: "read",
  },
  {
    name: "sources",
    description:
      "Every source's settings and the names given to cameras, as the Settings page shows them, with no secrets",
    access: "read",
  },
  {
    name: "cameras",
    description:
      "Every camera's id, name and what it can do, with its live stream names",
    access: "read",
  },
  {
    name: "recordings",
    description: "A camera's recordings on one day, with why each was made",
    access: "read",
  },
  {
    name: "download",
    description:
      "Save what a camera recorded between two times as an MP4 file, across recordings",
    access: "write",
  },
  {
    name: "days",
    description: "The days in a month that have recordings on any camera",
    access: "read",
  },
  {
    name: "events",
    description: "The newest events, such as motion and PIR, from every source",
    access: "read",
  },
  {
    name: "devices",
    description:
      "The devices paired with the server, such as browsers, phones and this CLI",
    access: "read",
  },
  {
    name: "config copy",
    description:
      "Copy this machine's sources, logins and camera names to another paired server, replacing its own",
    access: "write",
  },
  {
    name: "pair",
    description:
      "Pair this CLI with a server by a code, or with no code, show a code and QR code for another device; saves the token on this machine",
    access: "write",
  },
];

/** A client for `server`, signing every request in with `token` where there's one. */
export const clientFor = (
  server: string,
  token: Option.Option<Redacted.Redacted>,
) =>
  HttpApiClient.make(Api, {
    baseUrl: server,
    transformClient: (client) =>
      Option.match(token, {
        onNone: () => client,
        onSome: (bearer) =>
          HttpClient.mapRequest(client, HttpClientRequest.bearerToken(bearer)),
      }),
  });

type Client = Effect.Success<ReturnType<typeof clientFor>>;

/** A failed call to `server` as a `ClientError`, saying how to pair where it refused this CLI. */
export const asClientError = (server: string) => (error: Error) =>
  new ClientError({
    // The server refuses a CLI it doesn't know
    message:
      HttpClientError.isHttpClientError(error) && error.response?.status === 401
        ? `The server at ${server} needs this CLI paired: get a code from Settings, Devices on a paired browser, then run \`kestrel pair <code> --server ${server}\``
        : error.message,
  });

/** The Kestrel server's API, as the CLI and MCP server call it. */
export class ServerClient extends Context.Service<
  ServerClient,
  {
    /** Runs one call against the server, with its failures as a `ClientError`. */
    readonly call: <A, E extends Error>(
      use: (client: Client) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, ClientError>;
  }
>()("@timmo001/kestrel-cli/ServerClient") {
  static readonly layer = Layer.effect(
    ServerClient,
    Effect.gen(function* () {
      const { server, token } = yield* connection;
      const client = yield* clientFor(server, token);

      return ServerClient.of({
        call: (use) => use(client).pipe(Effect.mapError(asClientError(server))),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

const decodeCameraId = Schema.decodeUnknownOption(CameraId);

/**
 * A camera from a flag or a tool's parameter: its id, such as `swann/3`, or
 * while there's only one source, its own id, such as `3`, for that
 * source's camera.
 */
export const resolveCamera = Effect.fn("resolveCamera")(function* (
  value: string,
) {
  const id = decodeCameraId(value);

  if (Option.isSome(id)) return id.value;

  const sources = yield* (yield* ServerClient).call((api) =>
    api.sources.list(),
  );

  const only = sources.length === 1 ? sources[0] : undefined;

  if (only !== undefined && /^[a-z0-9][a-z0-9-]*$/.test(value)) {
    return cameraId(only.id, value);
  }

  return yield* new ClientError({
    message: `"${value}" isn't a camera: name it by id, such as swann/3; \`kestrel cameras\` lists them`,
  });
});

/**
 * The source a flag or parameter names, or without one, the only source
 * with details.
 */
export const resolveSource = Effect.fn("resolveSource")(function* (
  named: Option.Option<string>,
) {
  const sources = yield* (yield* ServerClient).call((api) =>
    api.sources.list(),
  );

  const withDetails = sources.filter((source) => source.details);

  const found: SourceInfo | undefined = Option.match(named, {
    onSome: (id) => sources.find((source) => source.id === id),
    onNone: () => (withDetails.length === 1 ? withDetails[0] : undefined),
  });

  if (found === undefined) {
    return yield* new ClientError({
      message: Option.isSome(named)
        ? `There's no source ${named.value}; \`kestrel status\` lists them`
        : "Name the source with --source; `kestrel status` lists them",
    });
  }

  return found;
});
