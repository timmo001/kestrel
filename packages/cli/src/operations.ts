/**
 * The operations the CLI and MCP server share, and the `Recorder` service
 * they run against: the server's API, at `KESTREL_SERVER`. Every
 * operation only reads from the sources; `download` also writes a file on
 * this machine, so it's marked as a write. It's CLI-only, as a video file
 * means nothing in an MCP reply. Cameras are named by id, such as
 * `swann/3`.
 *
 * @module
 */
import { CameraId, cameraId } from "@timmo001/kestrel-core/domain";
import { Api } from "@timmo001/kestrel-server/api";
import { Config, Context, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/** The server couldn't be reached, or couldn't reach a source, or the input doesn't read. */
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
      "What needs you, each source's connection, and the recorder's clock, disks and each channel's state",
    access: "read",
  },
  {
    name: "device",
    description: "The recorder's name, firmware and channel count",
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
    description: "The newest motion, PIR, video loss and disk reports",
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

const decodeCameraId = Schema.decodeUnknownOption(CameraId);

/**
 * A camera from a flag or a tool's parameter: its id, such as `swann/3`, or
 * while there's only one source, a bare number such as `3` for that
 * source's camera.
 */
export const resolveCamera = Effect.fn("resolveCamera")(function* (
  value: string,
) {
  const id = decodeCameraId(value);

  if (Option.isSome(id)) return id.value;

  const sources = yield* (yield* Recorder).call((api) => api.sources.list());
  const only = sources.length === 1 ? sources[0] : undefined;

  if (only !== undefined && /^[a-z0-9][a-z0-9-]*$/.test(value)) {
    return cameraId(only.id, value);
  }

  return yield* new RecorderError({
    message: `"${value}" isn't a camera: name it by id, such as swann/3; \`kestrel cameras\` lists them`,
  });
});

/** The first source with a device and status, such as the recorder. */
export const recorderSource = Effect.fn("recorderSource")(function* () {
  const sources = yield* (yield* Recorder).call((api) => api.sources.list());
  const found = sources.find((source) => source.details);

  if (found === undefined) {
    return yield* new RecorderError({
      message: "No source has a device and status to show",
    });
  }

  return found;
});
