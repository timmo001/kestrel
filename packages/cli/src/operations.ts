/**
 * The operations the CLI and MCP server share, and the `Recorder` service
 * they run against: the server's API, at `KESTREL_SERVER`. Every
 * operation only reads from the recorder; `download` also writes a file on
 * this machine, so it's marked as a write. It's CLI-only, as a video file
 * means nothing in an MCP reply.
 *
 * @module
 */
import { Api } from "@timmo001/kestrel-server/api";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/** The server couldn't be reached, or couldn't reach the recorder. */
export class RecorderError extends Schema.TaggedError<RecorderError>()(
  "RecorderError",
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
      "What needs you, and the recorder's connection, clock, disks and each channel's state",
    access: "read",
  },
  {
    name: "device",
    description: "The recorder's name, firmware and channel count",
    access: "read",
  },
  {
    name: "recordings",
    description: "A channel's recordings on one day, with why each was made",
    access: "read",
  },
  {
    name: "download",
    description:
      "Save what a channel recorded between two times as an MP4 file, across recordings",
    access: "write",
  },
  {
    name: "days",
    description: "The days in a month that have recordings",
    access: "read",
  },
  {
    name: "events",
    description: "The newest motion, PIR, video loss and disk reports",
    access: "read",
  },
  {
    name: "video",
    description:
      "Where the server serves go2rtc, and each channel's live stream names",
    access: "read",
  },
];

const makeClient = Effect.gen(function* () {
  const baseUrl = yield* Config.String("KESTREL_SERVER").pipe(
    Config.withDefault("http://127.0.0.1:7380"),
  );

  return yield* HttpApiClient.make(Api, { baseUrl });
});

type Client = Effect.Success<typeof makeClient>;

export class Recorder extends Context.Service<
  Recorder,
  {
    /** Runs one call against the server, with its failures as a `RecorderError`. */
    readonly call: <A, E>(
      use: (client: Client) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, RecorderError>;
  }
>()("@timmo001/kestrel-cli/Recorder") {
  static readonly layer = Layer.effect(
    Recorder,
    Effect.gen(function* () {
      const client = yield* makeClient;

      return Recorder.of({
        call: (use) =>
          use(client).pipe(
            Effect.mapError(
              (error) =>
                new RecorderError({
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
