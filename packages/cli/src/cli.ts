#!/usr/bin/env bun
/**
 * The `kestrel` CLI: the cameras' status, recordings and events from the
 * server, with `--json` for scripts and agents, `agent tools --json` for
 * Code Mode and `mcp` to serve the same operations over MCP. `pair` pairs
 * it with a server, or shows a code for another device, and `devices`
 * lists or removes the paired ones.
 *
 * @module
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  cameraParts,
  hoursText,
  LocalTime,
  type Attention,
  type Camera,
  type CameraEvent,
  type CameraId,
  type Details,
  type RecordedDay,
  type Recording,
  type Settings,
  type SourceId,
  type SourceInfo,
  version,
} from "@timmo001/kestrel-core";
import type {
  Device,
  PairingCode,
  ServerInfo,
} from "@timmo001/kestrel-server/api";
import { hostname } from "node:os";
import {
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { renderUnicodeCompact } from "uqr";
import {
  connection,
  connectionTo,
  localServer,
  writeSaved,
} from "./connection.ts";
import { localSettings } from "./copy.ts";
import { serveMcp } from "./mcp.ts";
import {
  asClientError,
  ClientError,
  clientFor,
  matchVersion,
  operations,
  resolveCamera,
  resolveSource,
  ServerClient,
  type Operation,
} from "./operations.ts";

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON for scripts and agents instead of text"),
  Flag.withDefault(false),
);

/** Everything a command prints with `--json`. */
type Output =
  | {
      readonly sources: ReadonlyArray<SourceInfo>;
      /** How many alerts there are, for scripts that only need the count. */
      readonly alerts: number;
      readonly attention: ReadonlyArray<Attention>;
      /** Each connected source's details, where it has them. */
      readonly details: ReadonlyArray<{
        readonly source: SourceId;
        readonly details: Details;
      }>;
    }
  | Details
  | Settings
  | { readonly cameras: ReadonlyArray<Camera> }
  | { readonly recordings: ReadonlyArray<Recording> }
  | { readonly days: ReadonlyArray<RecordedDay> }
  | { readonly events: ReadonlyArray<CameraEvent> }
  | { readonly devices: ReadonlyArray<Device> }
  | { readonly pairing: PairingCode }
  | {
      readonly copied: {
        readonly server: string;
        readonly sources: ReadonlyArray<string>;
        readonly dropped: ReadonlyArray<string>;
      };
    }
  | {
      readonly paired: {
        readonly server: ServerInfo;
        readonly device: Device;
        readonly file: string;
      };
    }
  | {
      readonly file: string;
      readonly bytes: number;
      readonly camera: CameraId;
      readonly begin: string;
      readonly end: string;
    }
  | {
      readonly tool: string;
      readonly operations: ReadonlyArray<
        Operation & {
          readonly command: ReadonlyArray<string>;
          readonly json: boolean;
        }
      >;
    };

const printJson = (value: Output) =>
  Console.log(JSON.stringify(value, null, 2));

/** Today in this machine's time zone, which a source's clock is kept in. */
const today = () => {
  const now = new Date();

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
};

/** A source's details as lines: its clock, storage and each camera's state. */
const printDetails = Effect.fn("printDetails")(function* (details: Details) {
  yield* Console.log(`Clock  ${details.clock?.replace("T", " ") ?? "unknown"}`);

  for (const each of details.storage) {
    yield* Console.log(`${each.name} ${each.state}`);
  }

  for (const each of details.cameras) {
    yield* Console.log(
      `${each.camera}  ${each.signal === false ? "no signal" : each.recording}${each.motion === true ? "  motion" : ""}`,
    );
  }
});

const status = Command.make(
  "status",
  { json },
  Effect.fn("status")(function* ({ json }) {
    const client = yield* ServerClient;
    const sources = yield* client.call((api) => api.sources.list());
    const attention = yield* client.call((api) => api.attention.list());

    const alerts = attention.filter((item) => item.level === "alert").length;

    // Each connected source's details, such as a recorder's disks and channels
    const details = yield* Effect.forEach(
      sources.filter((source) => source.details && source.connection.connected),
      (source) =>
        client
          .call((api) => api.sources.details({ params: { source: source.id } }))
          .pipe(Effect.map((found) => ({ source: source.id, details: found }))),
    );

    if (json) return yield* printJson({ sources, alerts, attention, details });

    for (const item of attention) {
      yield* Console.log(
        `${item.level === "alert" ? "●" : "○"} ${item.message}`,
      );
    }

    for (const each of details) yield* printDetails(each.details);
  }),
).pipe(
  Command.withDescription(
    "What needs you, and each source's connection, clock, storage and cameras",
  ),
);

const details = Command.make(
  "details",
  {
    json,
    source: Flag.String("source").pipe(
      Flag.withAlias("s"),
      Flag.withDescription(
        "The source, such as swann; the only one with details by default",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("details")(function* ({ json, source }) {
    const found = yield* resolveSource(source);

    const info = yield* (yield* ServerClient).call((api) =>
      api.sources.details({ params: { source: found.id } }),
    );

    if (json) return yield* printJson(info);

    for (const fact of info.facts) {
      yield* Console.log(`${fact.label}  ${fact.value}`);
    }

    yield* printDetails(info);
  }),
).pipe(
  Command.withDescription(
    "A source's details: its facts, clock, storage and each camera's state",
  ),
);

const camera = Flag.String("camera").pipe(
  Flag.withAlias("c"),
  Flag.withDescription(
    "The camera, such as swann/3; while there's one source, its camera's own id, such as 3",
  ),
);

const date = Flag.String("date").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("The day, such as 2026-11-11; today by default"),
  Flag.optional,
);

const sources = Command.make(
  "sources",
  { json },
  Effect.fn("sources")(function* ({ json }) {
    const settings = yield* (yield* ServerClient).call((api) =>
      api.sources.settings(),
    );

    if (json) return yield* printJson(settings);

    if (settings.sources.length === 0) {
      return yield* Console.log("No sources yet: add one on the Settings page");
    }

    for (const source of settings.sources) {
      const cameras =
        source.cameras.length === 0
          ? ""
          : `  ${source.cameras.length} camera${source.cameras.length === 1 ? "" : "s"}`;

      yield* Console.log(
        `${source.id}  ${source.name}  ${source.kind}${cameras}`,
      );
    }

    for (const each of settings.cameras) {
      yield* Console.log(`${each.camera}  named ${each.label}`);
    }

    if (settings.order.length > 0) {
      yield* Console.log(`Camera order  ${settings.order.join(", ")}`);
    }

    const recording = settings.recording;

    yield* Console.log(
      `Recording  ${recording.cameras.length === 0 ? "none" : recording.cameras.join(", ")} to ${recording.folder ?? "the state folder"}`,
    );

    yield* Console.log(
      `Keeping  ${hoursText(recording.continuousHours)} continuous, ${hoursText(recording.clipHours)} of clips, in up to ${recording.diskShare}% of the disk`,
    );
  }),
).pipe(
  Command.withDescription(
    "Every source's settings and the names given to cameras, with no secrets; --json for the settings themselves",
  ),
);

const cameras = Command.make(
  "cameras",
  { json },
  Effect.fn("cameras")(function* ({ json }) {
    const list = yield* (yield* ServerClient).call((api) => api.cameras.list());

    if (json) return yield* printJson({ cameras: list });

    if (list.length === 0) {
      return yield* Console.log("No cameras yet: is every source connected?");
    }

    for (const each of list) {
      const can = [
        each.live === null ? [] : ["live"],
        each.still ? ["still"] : [],
        each.recordings ? ["recordings"] : [],
        each.events ? ["events"] : [],
      ].flat();

      yield* Console.log(
        `${each.id}  ${each.label ?? each.name}  ${can.join(", ")}${each.signal === false ? "  no signal" : ""}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Every camera's id, its label or name, and what it can do, with its live stream names",
  ),
);

const recordings = Command.make(
  "recordings",
  { json, camera, date },
  Effect.fn("recordings")(function* ({ json, camera, date }) {
    const day = Option.getOrElse(date, today);
    const id = yield* resolveCamera(camera);

    const list = yield* (yield* ServerClient).call((api) =>
      api.cameras.recordings({ params: cameraParts(id), query: { date: day } }),
    );

    if (json) return yield* printJson({ recordings: list });

    if (list.length === 0) {
      return yield* Console.log(`No recordings on ${id} on ${day}`);
    }

    for (const recording of list) {
      yield* Console.log(
        `${recording.begin.slice(11)} to ${recording.end.slice(11)}  ${recording.reasons.join(", ")}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "A camera's recordings on one day, with why each was made",
  ),
);

const days = Command.make(
  "days",
  {
    json,
    month: Flag.String("month").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("The month, such as 2026-11; this month by default"),
      Flag.optional,
    ),
  },
  Effect.fn("days")(function* ({ json, month }) {
    const picked = Option.getOrElse(month, () => today().slice(0, 7));

    const list = yield* (yield* ServerClient).call((api) =>
      api.recordings.days({ query: { month: picked } }),
    );

    if (json) return yield* printJson({ days: list });

    yield* Console.log(
      list.length === 0
        ? `No recordings in ${picked}`
        : list.map((recorded) => recorded.date).join("\n"),
    );
  }),
).pipe(
  Command.withDescription(
    "The days in a month that have recordings on any camera",
  ),
);

const events = Command.make(
  "events",
  { json },
  Effect.fn("events")(function* ({ json }) {
    const list = yield* (yield* ServerClient).call((api) =>
      api.events.recent(),
    );

    if (json) return yield* printJson({ events: list });

    if (list.length === 0) {
      return yield* Console.log("No events since the server started");
    }

    for (const event of list) {
      yield* Console.log(
        `${event.receivedAt}  ${event.kind}${event.camera === null ? "" : `  ${event.camera}`}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "The newest events, such as motion and PIR, from every source",
  ),
);

const decodeTime = Schema.decodeUnknownEffect(LocalTime);

/**
 * A source's time from a flag: a full one such as `2026-11-11T21:46:00`, or
 * a time of day such as `21:46` or `21:46:30` on `day`.
 */
const timeOn = (day: string, value: string) => {
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);

  const full =
    clock === null
      ? value.replace(" ", "T")
      : `${day}T${clock[1]?.padStart(2, "0")}:${clock[2]}:${clock[3] ?? "00"}`;

  return decodeTime(full).pipe(
    Effect.mapError(
      () =>
        new ClientError({
          message: `"${value}" isn't a time: use 21:46, 21:46:30 or 2026-11-11T21:46:30`,
        }),
    ),
  );
};

const download = Command.make(
  "download",
  {
    json,
    camera,
    date,
    from: Flag.String("from").pipe(
      Flag.withDescription(
        "Where to start: a time on --date, such as 21:46, or a full one, such as 2026-11-11T21:46:00",
      ),
    ),
    to: Flag.String("to").pipe(
      Flag.withDescription("Where to stop, in the same forms as --from"),
    ),
    sub: Flag.Boolean("sub").pipe(
      Flag.withDescription("The small sub stream instead of the full one"),
      Flag.withDefault(false),
    ),
    output: Flag.String("output").pipe(
      Flag.withAlias("o"),
      Flag.withDescription(
        "The file to write; swann-3_2026-11-11T21-46-00.mp4 and so on by default",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("download")(function* (options) {
    const day = Option.getOrElse(options.date, today);
    const begin = yield* timeOn(day, options.from);
    const end = yield* timeOn(day, options.to);

    if (end <= begin) {
      return yield* new ClientError({
        message: "--to must come after --from",
      });
    }

    const id = yield* resolveCamera(options.camera);

    const response = yield* (yield* ServerClient).call((api) =>
      api.cameras.video({
        params: cameraParts(id),
        query: {
          begin,
          end,
          stream: options.sub ? "sub" : "main",
          download: "true",
        },
      }),
    );

    const named = /filename="([^"]+)"/.exec(
      response.headers["content-disposition"],
    )?.[1];

    const file = Option.getOrElse(
      options.output,
      () => named ?? `${id.replace("/", "-")}.mp4`,
    );

    const fs = yield* FileSystem.FileSystem;

    yield* response.body.pipe(
      Stream.run(fs.sink(file)),
      Effect.mapError(
        (error) =>
          new ClientError({
            message: `The download stopped: ${error instanceof Error ? error.message : String(error)}`,
          }),
      ),
    );

    const bytes = Number((yield* fs.stat(file)).size);

    if (options.json) {
      return yield* printJson({
        file,
        bytes,
        camera: id,
        begin,
        end,
      });
    }

    yield* Console.log(
      `Saved ${file} (${(bytes / 1024 ** 2).toFixed(1)} MiB), ${id} from ${begin.replace("T", " ")} to ${end.slice(11)}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Save what a camera recorded between two times as an MP4, across recordings",
  ),
);

const pair = Command.make(
  "pair",
  {
    json,
    code: Argument.String("code").pipe(
      Argument.withDescription(
        "The code from the server, such as ABCD-EFGH; without one, shows a code for another device",
      ),
      Argument.optional,
    ),
    server: Flag.String("server").pipe(
      Flag.withDescription(
        "The server's address, such as http://192.168.1.20:7380; the saved one or this machine's by default",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("pair")(function* ({ json, code, server }) {
    if (Option.isNone(code)) {
      const local = yield* connection;

      const made = yield* (yield* ServerClient)
        .call((api) => api.devices.code())
        .pipe(
          Effect.mapError((error) =>
            local.server === localServer && Option.isNone(local.token)
              ? new ClientError({
                  message:
                    "Only the server's owner can make a code here: run this as the user the server runs as, such as `sudo -u kestrel kestrel pair`, or use Settings, Devices on a paired browser",
                })
              : error,
          ),
        );

      if (json) return yield* printJson({ pairing: made });

      yield* Console.log(
        `Pairing code ${made.code}, for one device, until ${new Date(made.expires).toLocaleTimeString()}`,
      );

      if (made.link === undefined) {
        return yield* Console.log(
          "This server only listens on this machine, so no other device can reach it yet",
        );
      }

      yield* Console.log(`\nScan it, or open ${made.link}\n`);
      yield* Console.log(renderUnicodeCompact(made.link));

      return;
    }

    const { server: current } = yield* connection;
    const target = Option.getOrElse(server, () => current).replace(/\/+$/, "");

    const paired = yield* clientFor(target, Option.none()).pipe(
      Effect.flatMap((client) =>
        matchVersion(client, target).pipe(
          Effect.andThen(
            client.devices.pair({
              payload: {
                code: code.value,
                name: `Command line on ${hostname()}`,
                kind: "cli",
              },
            }),
          ),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.catchTag("PairingRefused", () =>
        Effect.fail(
          new ClientError({
            message:
              "That code didn't work: it may be mistyped, used or out of time. Get a new one and try again",
          }),
        ),
      ),
      Effect.mapError((error) =>
        error instanceof ClientError
          ? error
          : new ClientError({
              message: `Couldn't pair with ${target}: ${error.message}`,
            }),
      ),
    );

    if (paired.token === undefined) {
      return yield* new ClientError({
        message: "The server paired this CLI but sent no token back",
      });
    }

    const file = yield* writeSaved({
      server: target,
      serverId: paired.server.id,
      token: paired.token,
    });

    if (json) {
      return yield* printJson({
        paired: { server: paired.server, device: paired.device, file },
      });
    }

    yield* Console.log(
      `Paired with ${paired.server.name} at ${target}, and saved in ${file}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Pair this CLI with a server by a code, or with no code, show a code and QR code for another device",
  ),
);

const devicesList = Command.make(
  "devices",
  { json },
  Effect.fn("devices")(function* ({ json }) {
    const list = yield* (yield* ServerClient).call((api) => api.devices.list());

    if (json) return yield* printJson({ devices: list });

    if (list.length === 0) {
      return yield* Console.log(
        "No devices are paired yet: `kestrel pair` shows a code for one",
      );
    }

    for (const device of list) {
      yield* Console.log(
        `${device.id}  ${device.name}  ${device.kind}  last used ${device.lastSeen?.replace("T", " ").slice(0, 16) ?? "never"}`,
      );
    }
  }),
);

const devicesRemove = Command.make(
  "remove",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription("The device's id, from `kestrel devices`"),
    ),
  },
  Effect.fn("devicesRemove")(function* ({ id }) {
    yield* (yield* ServerClient).call((api) =>
      api.devices.revoke({ params: { id } }),
    );

    yield* Console.log(`Unpaired ${id}`);
  }),
).pipe(
  Command.withDescription(
    "Unpair a device, so its token and its windows stop working",
  ),
);

const devices = devicesList.pipe(
  Command.withDescription(
    "The devices paired with the server, such as browsers, phones and this CLI",
  ),
  Command.withSubcommands([devicesRemove]),
);

const configCopy = Command.make(
  "copy",
  {
    json,
    server: Flag.String("server").pipe(
      Flag.withDescription(
        "The server to copy to, such as http://192.168.1.20:7380; the one `kestrel pair` saved by default",
      ),
      Flag.optional,
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription(
        "Drop the other server's sources that this machine doesn't have",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("configCopy")(function* ({ json, server, replace }) {
    const target = yield* connectionTo(server);

    if (target.server === localServer) {
      return yield* new ClientError({
        message:
          "That's this machine's own server: name the other one with --server, or pair with it first",
      });
    }

    const client = yield* clientFor(target.server, target.token).pipe(
      Effect.provide(FetchHttpClient.layer),
    );

    const call = <A, E extends Error>(
      use: (api: typeof client) => Effect.Effect<A, E>,
    ) => use(client).pipe(Effect.mapError(asClientError(target.server)));

    yield* matchVersion(client, target.server);

    const kinds = yield* call((api) => api.sources.kinds());
    const theirs = yield* call((api) => api.sources.settings());
    const ours = yield* localSettings(kinds);

    const dropped = theirs.sources
      .filter((source) => !ours.sources.some((each) => each.id === source.id))
      .map((source) => source.id);

    if (dropped.length > 0 && !replace) {
      return yield* new ClientError({
        message: `${target.server} has sources this machine doesn't: ${dropped.join(", ")}. Run again with --replace to drop them`,
      });
    }

    // Saved against what the other server has now, so a change made there
    // in the meantime isn't overwritten
    yield* call((api) =>
      api.sources.save({
        payload: {
          sources: ours.sources,
          cameras: ours.cameras,
          order: ours.order,
          recording: ours.recording,
          // The settings read back always carry one
          revision: theirs.revision ?? "",
        },
      }),
    );

    const copied = ours.sources.map((source) => source.id);

    if (json) {
      return yield* printJson({
        copied: { server: target.server, sources: copied, dropped },
      });
    }

    yield* Console.log(
      `Copied ${copied.length} source${copied.length === 1 ? "" : "s"} (${copied.join(", ")}) to ${target.server}${dropped.length > 0 ? `, dropping ${dropped.join(", ")}` : ""}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Copy this machine's sources, logins and camera names to another server, through its API",
  ),
);

const config = Command.make("config").pipe(
  Command.withDescription("This machine's setup"),
  Command.withSubcommands([configCopy]),
);

/** The Code Mode manifest: every operation with how an agent may use it. */
const agentTools = Command.make(
  "tools",
  { json },
  Effect.fn("agentTools")(function* () {
    yield* printJson({
      tool: "kestrel",
      operations: operations.map((operation) => ({
        name: operation.name,
        description: operation.description,
        access: operation.access,
        command: ["kestrel", ...operation.name.split(" ")],
        json: true,
      })),
    });
  }),
).pipe(Command.withDescription("Print the Code Mode manifest as JSON"));

const agent = Command.make("agent").pipe(
  Command.withDescription("Agent surfaces"),
  Command.withSubcommands([agentTools]),
);

const mcp = Command.make("mcp", {}, () => serveMcp).pipe(
  Command.withDescription("Serve the operations over MCP on stdio"),
);

const cli = Command.make("kestrel").pipe(
  Command.withDescription(
    "Read your cameras' status, recordings and events through the Kestrel server",
  ),
  Command.withSubcommands([
    status,
    details,
    sources,
    cameras,
    recordings,
    download,
    days,
    events,
    devices,
    pair,
    config,
    agent,
    mcp,
  ]),
);

cli.pipe(
  Command.run({ version }),
  Effect.provide(
    ServerClient.layer.pipe(Layer.provideMerge(BunServices.layer)),
  ),
  BunRuntime.runMain,
);
