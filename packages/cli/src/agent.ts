/**
 * The Code Mode surface. `kestrel agent tools --json` describes each tool,
 * and `kestrel agent call <tool>` runs one with its input as JSON on stdin,
 * as the CLI command it stands for with `--json`, so the OpenCode plugin in
 * `opencode-plugin/` only needs the binary, and its tools always match it.
 * Follows upnext's.
 *
 * @module
 */
import { Duration, Effect, Schema } from "effect";
import { ClientError } from "./operations.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Json);

/** One tool as the plugin registers it. */
export const ManifestTool = Schema.Struct({
  name: Schema.String,
  argv: Schema.Array(Schema.String),
  description: Schema.String,
  access: Schema.Literals(["read", "write"]),
  alwaysAsk: Schema.Boolean,
  pinned: Schema.Boolean,
  timeoutMillis: Schema.Int,
  json: Schema.Boolean,
  // The whole input goes to the command as JSON on stdin.
  stdin: Schema.Boolean,
  input: JsonObject,
  // The input key whose value narrows the write permission below the tool,
  // such as download's camera, so "always allow" covers one camera.
  // JSON.stringify leaves it out when unset.
  resource: Schema.optional(Schema.String),
});

export type ManifestTool = typeof ManifestTool.Type;

/** Every tool the plugin registers. */
export const Manifest = Schema.Struct({ tools: Schema.Array(ManifestTool) });

export type Manifest = typeof Manifest.Type;

interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly access: "read" | "write";
  readonly alwaysAsk: boolean;
  readonly pinned: boolean;
  readonly timeout: Duration.Duration;
  readonly resource: string | undefined;
  readonly input: Schema.Json;
  /** The CLI arguments for this call, decoded from its JSON input. */
  readonly args: (
    text: string,
  ) => Effect.Effect<ReadonlyArray<string>, ClientError>;
}

const isJsonObject = Schema.is(JsonObject);

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const jsonSchemaOf = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error",
  });

  return decodeJson(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  );
};

/** `--name value` where the input has a value, and nothing where it doesn't. */
const flag = (name: string, value: string | undefined) =>
  value === undefined ? [] : [`--${name}`, value];

/** `--name` where the input turns it on. */
const toggle = (name: string, value: boolean | undefined) =>
  value === true ? [`--${name}`] : [];

// Binds a tool's input schema to the arguments it becomes, so each call
// decodes its stdin strictly before the command runs.
const tool = <I, IE>(definition: {
  readonly name: string;
  /** The CLI command, when it isn't the tool's name. */
  readonly command?: ReadonlyArray<string>;
  readonly description: string;
  readonly access: "read" | "write";
  readonly alwaysAsk?: boolean;
  readonly pinned?: boolean;
  readonly timeout?: Duration.Input;
  readonly resource?: string;
  readonly input: Schema.Codec<I, IE>;
  readonly args: (input: I) => ReadonlyArray<string>;
}): AgentTool => {
  const decode = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.toCodecJson(definition.input)),
  );

  return {
    name: definition.name,
    description: definition.description,
    access: definition.access,
    alwaysAsk: definition.alwaysAsk ?? false,
    pinned: definition.pinned ?? false,
    timeout: Duration.fromInputUnsafe(definition.timeout ?? "2 minutes"),
    resource: definition.resource,
    input: jsonSchemaOf(definition.input),
    args: (text) =>
      decode(text.trim() === "" ? "{}" : text, {
        onExcessProperty: "error",
        errors: "all",
      }).pipe(
        Effect.mapError(
          (error) =>
            new ClientError({ message: `Invalid input: ${error.message}` }),
        ),
        Effect.map((input) => [
          ...(definition.command ?? [definition.name]),
          "--json",
          ...definition.args(input),
        ]),
      ),
  };
};

// Struct({}) accepts any keys, so a tool that takes none uses this instead.
const NoInput = Schema.Record(Schema.String, Schema.Never);

const none = () => [];

const Camera = Schema.String.annotate({
  description:
    "The camera's id, such as swann/3; while there's one source, its own id, such as 3",
});

const Day = Schema.String.annotate({
  description: "The day, such as 2026-11-11; today by default",
});

/** Every Code Mode tool, in the order the catalogue lists them. */
export const agentTools: ReadonlyArray<AgentTool> = [
  tool({
    name: "status",
    description:
      "What needs you, and each source's connection, clock, storage and cameras",
    access: "read",
    pinned: true,
    input: NoInput,
    args: none,
  }),
  tool({
    name: "details",
    description:
      "A source's details: its facts, clock, storage and each camera's state",
    access: "read",
    input: Schema.Struct({
      source: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The source, such as swann; the only one with details by default",
        }),
      ),
    }),
    args: (input) => flag("source", input.source),
  }),
  tool({
    name: "sources",
    description:
      "Every source's settings and the names given to cameras, as the Settings page shows them, with no secrets",
    access: "read",
    input: NoInput,
    args: none,
  }),
  tool({
    name: "cameras",
    description:
      "Every camera's id, name and what it can do, with its live stream names",
    access: "read",
    input: NoInput,
    args: none,
  }),
  tool({
    name: "recordings",
    description: "A camera's recordings on one day, with why each was made",
    access: "read",
    input: Schema.Struct({
      camera: Camera,
      date: Schema.optionalKey(Day),
    }),
    args: (input) => [
      ...flag("camera", input.camera),
      ...flag("date", input.date),
    ],
  }),
  tool({
    name: "download",
    description:
      "Save what a camera recorded between two times as an MP4 file in the session's folder, across recordings. Find the times with recordings first",
    access: "write",
    timeout: "10 minutes",
    resource: "camera",
    input: Schema.Struct({
      camera: Camera,
      date: Schema.optionalKey(Day),
      from: Schema.String.annotate({
        description:
          "Where to start: a time on date, such as 21:46, or a full one, such as 2026-11-11T21:46:00",
      }),
      to: Schema.String.annotate({
        description: "Where to stop, in the same forms as from",
      }),
      sub: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "The small sub stream instead of the full one",
        }),
      ),
      output: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The file to write; named after the camera and start by default",
        }),
      ),
    }),
    args: (input) => [
      ...flag("camera", input.camera),
      ...flag("date", input.date),
      ...flag("from", input.from),
      ...flag("to", input.to),
      ...toggle("sub", input.sub),
      ...flag("output", input.output),
    ],
  }),
  tool({
    name: "days",
    description: "The days in a month that have recordings on any camera",
    access: "read",
    input: Schema.Struct({
      month: Schema.optionalKey(
        Schema.String.annotate({
          description: "The month, such as 2026-11; this month by default",
        }),
      ),
    }),
    args: (input) => flag("month", input.month),
  }),
  tool({
    name: "events",
    description: "The newest events, such as motion and PIR, from every source",
    access: "read",
    input: NoInput,
    args: none,
  }),
  tool({
    name: "devices",
    description:
      "The devices paired with the server, such as browsers, phones and this CLI",
    access: "read",
    input: NoInput,
    args: none,
  }),
  tool({
    name: "jobs",
    description:
      "What the server does by itself, such as copying recordings from sources, recording each camera and clearing out old recordings: each job's state, progress, last run and last error, with the recordings copied lately",
    access: "read",
    input: NoInput,
    args: none,
  }),
  tool({
    name: "usage",
    description:
      "The server's memory and CPU, with go2rtc and ffmpeg, against the limits background work keeps to, the machine's memory and load, the recordings' disk use by camera, and whether background work is waiting and why",
    access: "read",
    input: NoInput,
    args: none,
  }),
  tool({
    name: "servers",
    description: "The Kestrel servers on this network, found over mDNS",
    access: "read",
    input: NoInput,
    args: none,
  }),
  tool({
    name: "config_copy",
    command: ["config", "copy"],
    description:
      "Copy this machine's sources, logins and camera names to another paired server, replacing its own. Only when the person asks for it",
    access: "write",
    alwaysAsk: true,
    resource: "server",
    input: Schema.Struct({
      server: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The server to copy to, such as http://192.168.1.20:7380; the one `kestrel pair` saved by default",
        }),
      ),
      replace: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "Drop the other server's sources that this machine doesn't have",
        }),
      ),
    }),
    args: (input) => [
      ...flag("server", input.server),
      ...toggle("replace", input.replace),
    ],
  }),
  tool({
    name: "pair",
    description:
      "Pair this CLI with a server by a code the person gives, or with no code, make a code for another device; saves the token on this machine",
    access: "write",
    alwaysAsk: true,
    resource: "server",
    input: Schema.Struct({
      code: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The code from the server, such as ABCD-EFGH; without one, makes a code for another device",
        }),
      ),
      server: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The server's address, such as http://192.168.1.20:7380; the saved one, or the only one on the network, by default",
        }),
      ),
    }),
    args: (input) => [
      ...(input.code === undefined ? [] : [input.code]),
      ...flag("server", input.server),
    ],
  }),
];

/** The Code Mode manifest. */
export const manifest: Manifest = {
  tools: agentTools.map((entry) => ({
    name: entry.name,
    argv: ["agent", "call", entry.name],
    description: entry.description,
    access: entry.access,
    alwaysAsk: entry.alwaysAsk,
    pinned: entry.pinned,
    timeoutMillis: Duration.toMillis(entry.timeout),
    json: true,
    stdin: true,
    input: isJsonObject(entry.input) ? entry.input : {},
    resource: entry.resource,
  })),
};

/** The CLI arguments for one tool's call, from its JSON input. */
export const callArgs = Effect.fn("callArgs")(function* (
  name: string,
  text: string,
) {
  const entry = agentTools.find((candidate) => candidate.name === name);

  if (entry === undefined) {
    return yield* new ClientError({ message: `No tool ${name}` });
  }

  return yield* entry.args(text);
});
