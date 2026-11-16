#!/usr/bin/env bun
/**
 * The `kestrel` CLI: the cameras' status, recordings and events from the
 * server, with `--json` for scripts and agents, `agent tools --json` and
 * `agent call` for Code Mode and `mcp` to serve the same operations over
 * MCP. `pair` pairs
 * it with a server, or shows a code for another device, `devices`
 * lists or removes the paired ones, `jobs` and `usage` say what the
 * server does by itself and how much of the machine it uses, and `backups`
 * makes, lists and restores backups.
 *
 * @module
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  cameraParts,
  hoursText,
  LocalDate,
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
import {
  type BackupFile,
  type BackupRequest,
  type Device,
  type Job,
  lockedMark,
  type PairingCode,
  passphraseHeader,
  type RestoreMode,
  type ServerInfo,
  type UsageReport,
} from "@timmo001/kestrel-server/api";
import { browse, type FoundServer } from "@timmo001/kestrel-core/discovery";
import { hostname } from "node:os";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stdio,
  Stream,
} from "effect";
import {
  Argument,
  Command,
  Flag,
  Prompt,
  TerminalCapabilities,
} from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { renderUnicodeCompact } from "uqr";
import { callArgs, manifest, type Manifest } from "./agent.ts";
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
  resolveCamera,
  resolveSource,
  ServerClient,
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
  | { readonly jobs: ReadonlyArray<Job> }
  | UsageReport
  | { readonly pairing: PairingCode }
  | { readonly servers: ReadonlyArray<FoundServer> }
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
  | { readonly backups: ReadonlyArray<BackupFile> }
  | {
      readonly backup:
        | { readonly name: string }
        | { readonly file: string; readonly bytes: number };
    }
  | { readonly removed: string }
  | {
      readonly restoring: {
        readonly backup: string;
        readonly recordings: RestoreMode;
      };
    }
  | Manifest;

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
        `${source.id}  ${source.name}  ${source.kind}${cameras}${source.enabled ? "" : "  off"}`,
      );
    }

    for (const each of settings.cameras) {
      yield* Console.log(`${each.camera}  named ${each.label}`);
    }

    if (settings.order.length > 0) {
      yield* Console.log(`Camera order  ${settings.order.join(", ")}`);
    }

    if (settings.off.length > 0) {
      yield* Console.log(`Cameras off  ${settings.off.join(", ")}`);
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
        `${each.id}  ${each.label ?? each.name}  ${can.join(", ")}${each.enabled ? "" : "  off"}${each.signal === false ? "  no signal" : ""}`,
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

const decodeDay = Schema.decodeUnknownEffect(LocalDate);

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

/** The one Kestrel server on the network, failing where there's none or several. */
const onlyServer = Effect.gen(function* () {
  const found = yield* browse("3 seconds");
  const [only] = found;

  if (found.length === 1 && only !== undefined) return only.url;

  return yield* new ClientError({
    message:
      found.length === 0
        ? "No Kestrel server answered on this network: name it with --server"
        : `More than one Kestrel server answered (${found.map((each) => `${each.name} at ${each.url}`).join(", ")}): name one with --server`,
  });
});

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
        "The server's address, such as http://192.168.1.20:7380; the saved one, or the only one on the network, by default",
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

    // Without an address, the server set or saved before, else the only one
    // on the network
    const target = Option.isSome(server)
      ? server.value.replace(/\/+$/, "")
      : current !== localServer
        ? current
        : yield* onlyServer;

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

const megabyte = 1024 * 1024;

/** Bytes in KB below a megabyte, MB, or GB from a gigabyte. */
const bytesText = (bytes: number) =>
  bytes >= 1024 * megabyte
    ? `${(bytes / (1024 * megabyte)).toFixed(1)} GB`
    : bytes < megabyte
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${Math.round(bytes / megabyte)} MB`;

/** An ISO time as `2026-11-13 19:20`. */
const shortTime = (iso: string) => iso.replace("T", " ").slice(0, 16);

/**
 * The passphrase a backup locks or opens with: `KESTREL_BACKUP_PASSPHRASE`,
 * else typed at the terminal, so it's never on a command line. `twice` asks
 * again to catch a typo, for one that locks.
 */
const passphraseFor = Effect.fn("passphraseFor")(function* (
  why: string,
  twice: boolean,
) {
  const set = yield* Config.option(
    Config.Redacted("KESTREL_BACKUP_PASSPHRASE"),
  ).pipe(
    Effect.mapError(
      (error) => new ClientError({ message: `${why}: ${error.message}` }),
    ),
  );

  if (Option.isSome(set)) return Redacted.value(set.value);

  const { canPrompt } = yield* TerminalCapabilities.TerminalCapabilities;

  if (!canPrompt) {
    return yield* new ClientError({
      message: `${why}: set KESTREL_BACKUP_PASSPHRASE, or run this in a terminal to type it`,
    });
  }

  const ask = (message: string) =>
    Prompt.run(Prompt.Password({ message })).pipe(
      Effect.map(Redacted.value),
      Effect.mapError(
        () => new ClientError({ message: "No passphrase was typed" }),
      ),
    );

  const typed = yield* ask("Passphrase");

  if (typed === "") {
    return yield* new ClientError({ message: "The passphrase can't be empty" });
  }

  if (twice && (yield* ask("The passphrase again")) !== typed) {
    return yield* new ClientError({
      message: "The passphrases didn't match, so nothing was made",
    });
  }

  return typed;
});

const backupsList = Command.make(
  "backups",
  { json },
  Effect.fn("backups")(function* ({ json }) {
    const list = yield* (yield* ServerClient).call((api) => api.backups.list());

    if (json) return yield* printJson({ backups: list });

    if (list.length === 0) {
      return yield* Console.log(
        "No backups are kept on the server: `kestrel backups make --keep` makes one",
      );
    }

    for (const backup of list) {
      yield* Console.log(
        `${backup.name}  ${bytesText(backup.bytes)}  ${shortTime(backup.modified)}${backup.locked ? "  locked" : ""}`,
      );
    }
  }),
);

/** Saves a backup the server streams to `file`, or the name it gives, and says how big it came out. */
const saveBackup = Effect.fn("saveBackup")(function* (
  response: {
    readonly body: Stream.Stream<Uint8Array, Error>;
    readonly headers: { readonly "content-disposition": string };
  },
  output: Option.Option<string>,
) {
  const named = /filename="([^"]+)"/.exec(
    response.headers["content-disposition"],
  )?.[1];

  const file = Option.getOrElse(
    output,
    () => named ?? "kestrel.kestrel-backup",
  );

  const fs = yield* FileSystem.FileSystem;

  yield* response.body.pipe(
    Stream.run(fs.sink(file)),
    Effect.mapError(
      (error) =>
        new ClientError({ message: `The backup stopped: ${error.message}` }),
    ),
  );

  const bytes = Number((yield* fs.stat(file)).size);

  return { file, bytes };
});

const output = Flag.String("output").pipe(
  Flag.withAlias("o"),
  Flag.withDescription(
    "The file to write; the name the server gives, such as kestrel-2026-11-15T23-40-12.kestrel-backup, by default",
  ),
  Flag.optional,
);

const backupsMake = Command.make(
  "make",
  {
    json,
    keep: Flag.Boolean("keep").pipe(
      Flag.withDescription(
        "Keep it in the server's backups folder instead of downloading it here",
      ),
      Flag.withDefault(false),
    ),
    noRecordings: Flag.Boolean("no-recordings").pipe(
      Flag.withDescription("Leave the recordings out"),
      Flag.withDefault(false),
    ),
    cameras: Flag.String("camera").pipe(
      Flag.withDescription(
        "Only this camera's recordings, such as swann/3; give it again for more. Every camera's by default",
      ),
      Flag.atLeast(0),
    ),
    from: Flag.String("from").pipe(
      Flag.withDescription(
        "Only recordings from this day on, such as 2026-11-01",
      ),
      Flag.optional,
    ),
    to: Flag.String("to").pipe(
      Flag.withDescription(
        "Only recordings up to and including this day, such as 2026-11-15",
      ),
      Flag.optional,
    ),
    lock: Flag.Boolean("lock").pipe(
      Flag.withDescription(
        "Lock it with a passphrase, from KESTREL_BACKUP_PASSPHRASE or typed in, which restoring it then needs",
      ),
      Flag.withDefault(false),
    ),
    output,
  },
  Effect.fn("backupsMake")(function* (options) {
    const day = (value: string, flag: string) =>
      decodeDay(value).pipe(
        Effect.mapError(
          () =>
            new ClientError({
              message: `--${flag} "${value}" isn't a day: use 2026-11-15`,
            }),
        ),
      );

    const from = Option.isSome(options.from)
      ? yield* day(options.from.value, "from")
      : undefined;

    const to = Option.isSome(options.to)
      ? yield* day(options.to.value, "to")
      : undefined;

    if (from !== undefined && to !== undefined && from > to) {
      return yield* new ClientError({
        message: "--from needs to come before --to",
      });
    }

    const cameras = yield* Effect.forEach(options.cameras, resolveCamera);

    const passphrase = options.lock
      ? yield* passphraseFor("Locking the backup needs a passphrase", true)
      : undefined;

    const request: BackupRequest = {
      recordings: options.noRecordings ? false : undefined,
      cameras: cameras.length > 0 ? cameras : undefined,
      from,
      to,
      passphrase,
    };

    const client = yield* ServerClient;

    if (options.keep) {
      const { name } = yield* client.call((api) =>
        api.backups.create({ payload: request }),
      );

      if (options.json) return yield* printJson({ backup: { name } });

      return yield* Console.log(
        `Making ${name} in the server's backups folder; \`kestrel jobs\` shows the backup job, and \`kestrel backups\` lists it once it's made`,
      );
    }

    const { path } = yield* client.call((api) =>
      api.backups.link({ payload: request }),
    );

    const code = path.split("/").at(-1) ?? "";

    const response = yield* client.call((api) =>
      api.backups.download({ params: { code } }),
    );

    const saved = yield* saveBackup(response, options.output);

    if (options.json) return yield* printJson({ backup: saved });

    yield* Console.log(`Saved ${saved.file} (${bytesText(saved.bytes)})`);
  }),
).pipe(
  Command.withDescription(
    "Back up the settings, the sources' logins, the server's id, its paired devices and the recordings, all or some, and download it or keep it on the server",
  ),
);

const backupName = Argument.String("name").pipe(
  Argument.withDescription(
    "The backup's name on the server, from `kestrel backups`",
  ),
);

const backupsGet = Command.make(
  "get",
  { json, name: backupName, output },
  Effect.fn("backupsGet")(function* ({ json, name, output }) {
    const response = yield* (yield* ServerClient).call((api) =>
      api.backups.file({ params: { name } }),
    );

    const saved = yield* saveBackup(response, output);

    if (json) return yield* printJson({ backup: saved });

    yield* Console.log(`Saved ${saved.file} (${bytesText(saved.bytes)})`);
  }),
).pipe(Command.withDescription("Download a backup kept on the server"));

const backupsRemove = Command.make(
  "remove",
  { json, name: backupName },
  Effect.fn("backupsRemove")(function* ({ json, name }) {
    yield* (yield* ServerClient).call((api) =>
      api.backups.remove({ params: { name } }),
    );

    if (json) return yield* printJson({ removed: name });

    yield* Console.log(`Deleted ${name}`);
  }),
).pipe(Command.withDescription("Delete a backup kept on the server"));

const backupsRestore = Command.make(
  "restore",
  {
    json,
    backup: Argument.String("backup").pipe(
      Argument.withDescription(
        "A backup file here, or the name of one kept on the server, from `kestrel backups`",
      ),
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription(
        "Delete Kestrel's recordings on the server before putting the backup's in, instead of keeping them beside it",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("backupsRestore")(function* ({ json, backup, replace }) {
    const recordings: RestoreMode = replace ? "replace" : "merge";
    const fs = yield* FileSystem.FileSystem;
    const client = yield* ServerClient;
    const here = yield* fs.exists(backup);

    const locked = here
      ? (yield* fs
          .stream(backup, { bytesToRead: lockedMark.length })
          .pipe(Stream.decodeText(), Stream.mkString)) === lockedMark
      : (yield* client.call((api) => api.backups.list())).some(
          (each) => each.name === backup && each.locked,
        );

    const passphrase = locked
      ? yield* passphraseFor(
          "This backup is locked, so restoring it needs its passphrase",
          false,
        )
      : undefined;

    if (here) {
      yield* client.call((api) =>
        api.backups.upload({
          query: { recordings },
          headers: {
            [passphraseHeader]:
              passphrase === undefined
                ? undefined
                : encodeURIComponent(passphrase),
          },
          payload: fs.stream(backup),
        }),
      );
    } else {
      yield* client.call((api) =>
        api.backups.restore({
          params: { name: backup },
          payload: { recordings, passphrase },
        }),
      );
    }

    if (json) return yield* printJson({ restoring: { backup, recordings } });

    yield* Console.log(
      `Restoring ${backup}, ${replace ? "replacing" : "keeping"} the recordings already there. The server starts again once it's read it; \`kestrel jobs\` shows the restore until then`,
    );
  }),
).pipe(
  Command.withDescription(
    "Restore a backup, from a file here or one kept on the server: the settings, the server's id and its paired devices become the backup's, and the server starts again",
  ),
);

const backups = backupsList.pipe(
  Command.withDescription(
    "The backups kept on the server, and making, downloading, deleting and restoring them",
  ),
  Command.withSubcommands([
    backupsMake,
    backupsGet,
    backupsRemove,
    backupsRestore,
  ]),
);

const jobs = Command.make(
  "jobs",
  { json },
  Effect.fn("jobs")(function* ({ json }) {
    const list = yield* (yield* ServerClient).call((api) =>
      api.activity.jobs(),
    );

    if (json) return yield* printJson({ jobs: list });

    for (const job of list) {
      yield* Console.log(
        `${job.id}  ${job.state}  ${job.detail}  since ${shortTime(job.since)}`,
      );

      if (job.progress !== undefined) {
        yield* Console.log(
          `  ${job.progress.done} of ${job.progress.total} copied this pass, ${bytesText(job.progress.bytes)}`,
        );
      }

      for (const source of job.sources ?? []) {
        yield* Console.log(
          `  ${source.source}  ${source.copied} copied, ${source.left} left, ${bytesText(source.bytes)}`,
        );
      }

      if (job.lastRun !== undefined) {
        yield* Console.log(
          `  last run ${shortTime(job.lastRun.at)}: ${job.lastRun.summary}`,
        );
      }

      if (job.lastError !== undefined) {
        yield* Console.log(
          `  last error ${shortTime(job.lastError.at)}: ${job.lastError.message}`,
        );
      }
    }

    const recent = list.flatMap((job) => job.recent ?? []);

    if (recent.length > 0) yield* Console.log("\nCopied lately");

    for (const each of recent) {
      yield* Console.log(
        `  ${each.camera}  ${each.begin.replace("T", " ")}  ${bytesText(each.bytes)}  at ${shortTime(each.at)}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "What the server does by itself, such as copying from sources, recording and clearing out, and how each is getting on",
  ),
);

const usage = Command.make(
  "usage",
  { json },
  Effect.fn("usage")(function* ({ json }) {
    const report = yield* (yield* ServerClient).call((api) =>
      api.activity.usage(),
    );

    if (json) return yield* printJson(report);

    const { now, limits, disk } = report;
    const cores = Math.max(now.cores, 1);

    yield* Console.log(
      report.holdUp === undefined
        ? `Background work can run, copying up to ${limits.copyRate} MB a second`
        : `Background work is waiting: ${report.holdUp}`,
    );
    yield* Console.log(
      `Server  ${bytesText(now.kestrelMemory)} of ${limits.memoryLimit} MB memory, ${Math.round(now.kestrelCpu / cores)}% of ${limits.cpuShare}% CPU`,
    );

    for (const each of report.processes) {
      yield* Console.log(
        `  ${each.name}  ${bytesText(each.memory)}, ${Math.round(each.cpu)}% of a core`,
      );
    }

    yield* Console.log(
      `Machine  ${bytesText(now.memoryFree)} of ${bytesText(now.memory)} memory free (keeps ${limits.memoryFree}%), ${bytesText(now.swapUsed)} swap, load ${now.load.toFixed(2)} on ${now.cores} cores`,
    );
    yield* Console.log(
      `  waiting on memory ${now.memoryPressure.toFixed(1)}%, on disks ${now.diskPressure.toFixed(1)}% of the time`,
    );

    if (disk === undefined) return;

    yield* Console.log(
      `Recordings  ${bytesText(disk.recordings)}, ${bytesText(disk.free)} free of ${bytesText(disk.total)}`,
    );

    for (const camera of disk.cameras) {
      yield* Console.log(
        `  ${camera.camera}  ${camera.files} ${camera.files === 1 ? "file" : "files"}, ${bytesText(camera.bytes)}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "The server's memory and CPU against its limits, the machine's, and what recordings take on disk",
  ),
);

// The server's code only loads for `serve`, so every other command starts
// as quickly as before
const serve = Command.make("serve", {}, () =>
  Effect.promise(() => import("@timmo001/kestrel-server")).pipe(
    Effect.flatMap(({ Server }) => Server.fromEnvironment),
  ),
).pipe(
  Command.withDescription(
    "Run the server with no window, on every address unless KESTREL_HOST says otherwise; pair devices with `kestrel pair`",
  ),
);

const servers = Command.make(
  "servers",
  { json },
  Effect.fn("servers")(function* ({ json }) {
    const found = yield* browse("3 seconds");

    if (json) return yield* printJson({ servers: found });

    if (found.length === 0) {
      return yield* Console.log(
        "No Kestrel servers answered on this network in 3 seconds",
      );
    }

    for (const server of found) {
      yield* Console.log(
        `${server.name}  ${server.url}  ${server.version}${server.version === version ? "" : "  (another version)"}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "The Kestrel servers on this network, found over mDNS",
  ),
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
          off: ours.off,
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

/** The Code Mode manifest: every tool, its input and how an agent may use it. */
const agentTools = Command.make(
  "tools",
  { json },
  Effect.fn("agentTools")(function* () {
    yield* printJson(manifest);
  }),
).pipe(Command.withDescription("Print the Code Mode manifest as JSON"));

/** The commands an agent's call runs, behind `agent call`. */
const callable = Command.make("kestrel").pipe(
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
    jobs,
    usage,
    backups,
    pair,
    servers,
    config,
  ]),
);

const agentCall = Command.make(
  "call",
  {
    tool: Argument.String("tool").pipe(
      Argument.withDescription("The tool, as `agent tools` names it"),
    ),
  },
  Effect.fn("agentCall")(function* ({ tool }) {
    const input = yield* (yield* Stdio.Stdio).stdin.pipe(
      Stream.decodeText(),
      Stream.mkString,
    );

    const args = yield* callArgs(tool, input);

    yield* Command.runWith(callable, { version })(args);
  }),
).pipe(
  Command.withDescription(
    "Run one Code Mode tool with its input as JSON on stdin, printing JSON",
  ),
);

const agent = Command.make("agent").pipe(
  Command.withDescription("Agent surfaces"),
  Command.withSubcommands([agentTools, agentCall]),
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
    jobs,
    usage,
    backups,
    pair,
    servers,
    serve,
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
