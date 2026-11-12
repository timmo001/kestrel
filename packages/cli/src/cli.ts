#!/usr/bin/env bun
/**
 * The `kestrel` CLI: the cameras' status, recordings and events from the
 * server, with `--json` for scripts and agents, `agent tools --json` for
 * Code Mode and `mcp` to serve the same operations over MCP.
 *
 * @module
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  cameraParts,
  LocalTime,
  type Camera,
  type CameraId,
  type DeviceInfo,
  type ReceivedEvent,
  type RecordedDay,
  type RecorderStatus,
  type Recording,
  type SourceInfo,
} from "@timmo001/kestrel-core/domain";
import type { Attention } from "@timmo001/kestrel-server/api";
import {
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { Command, Flag } from "effect/cli";
import { serveMcp } from "./mcp.ts";
import {
  operations,
  Recorder,
  RecorderError,
  recorderSource,
  resolveCamera,
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
      /** The recorder's status, while it's connected. */
      readonly status: RecorderStatus | null;
    }
  | DeviceInfo
  | { readonly cameras: ReadonlyArray<Camera> }
  | { readonly recordings: ReadonlyArray<Recording> }
  | { readonly days: ReadonlyArray<RecordedDay> }
  | { readonly events: ReadonlyArray<ReceivedEvent> }
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

/** Today in this machine's time zone, which the recorder's clock is kept in. */
const today = () => {
  const now = new Date();

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
};

const status = Command.make(
  "status",
  { json },
  Effect.fn("status")(function* ({ json }) {
    const recorder = yield* Recorder;
    const sources = yield* recorder.call((api) => api.sources.list());
    const attention = yield* recorder.call((api) => api.sources.attention());

    const alerts = attention.filter((item) => item.level === "alert").length;

    // The recorder's clock, disks and channels, while it's connected
    const withDetails = sources.find(
      (source) => source.details && source.connection.connected,
    );

    const current =
      withDetails === undefined
        ? null
        : yield* recorder.call((api) =>
            api.sources.status({ params: { source: withDetails.id } }),
          );

    if (json) {
      return yield* printJson({
        sources,
        alerts,
        attention,
        status: current,
      });
    }

    for (const item of attention) {
      yield* Console.log(
        `${item.level === "alert" ? "●" : "○"} ${item.message}`,
      );
    }

    if (current === null) return;

    yield* Console.log(
      `Clock  ${current.time?.replace("T", " ") ?? "unknown"}`,
    );

    for (const disk of current.disks) {
      yield* Console.log(`Disk ${disk.disk} ${disk.state}`);
    }

    for (const channel of current.channels) {
      yield* Console.log(
        `Channel ${channel.channel}  ${channel.videoLoss ? "no signal" : channel.recordingMode}${channel.motion ? "  motion" : ""}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "What needs you, each source's connection, and the recorder's clock, disks and each channel's state",
  ),
);

const device = Command.make(
  "device",
  { json },
  Effect.fn("device")(function* ({ json }) {
    const source = yield* recorderSource();

    const info = yield* (yield* Recorder).call((api) =>
      api.sources.device({ params: { source: source.id } }),
    );

    if (json) return yield* printJson(info);

    yield* Console.log(
      `${info.name}  firmware ${info.firmware}  ${info.channels} channels  ${info.mac}`,
    );
  }),
).pipe(
  Command.withDescription("The recorder's name, firmware and channel count"),
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

const cameras = Command.make(
  "cameras",
  { json },
  Effect.fn("cameras")(function* ({ json }) {
    const list = yield* (yield* Recorder).call((api) => api.cameras.list());

    if (json) return yield* printJson({ cameras: list });

    if (list.length === 0) {
      return yield* Console.log("No cameras yet: is every source connected?");
    }

    for (const each of list) {
      const can = [
        each.live === null ? [] : ["live"],
        each.recordings ? ["recordings"] : [],
        each.events ? ["events"] : [],
      ].flat();

      yield* Console.log(
        `${each.id}  ${each.name}  ${can.join(", ")}${each.signal === false ? "  no signal" : ""}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Every camera's id, name and what it can do, with its live stream names",
  ),
);

const recordings = Command.make(
  "recordings",
  { json, camera, date },
  Effect.fn("recordings")(function* ({ json, camera, date }) {
    const day = Option.getOrElse(date, today);
    const id = yield* resolveCamera(camera);

    const list = yield* (yield* Recorder).call((api) =>
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

    const list = yield* (yield* Recorder).call((api) =>
      api.cameras.days({ query: { month: picked } }),
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
    const list = yield* (yield* Recorder).call((api) => api.events.recent());

    if (json) return yield* printJson({ events: list });

    if (list.length === 0) {
      return yield* Console.log("No alarm reports since the server started");
    }

    for (const event of list) {
      yield* Console.log(
        `${event.receivedAt}  ${event.kind}${event.camera === null ? "" : `  ${event.camera}`}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "The newest motion, PIR, video loss and disk reports",
  ),
);

const decodeTime = Schema.decodeUnknownEffect(LocalTime);

/**
 * A recorder time from a flag: a full one such as `2026-11-11T21:46:00`, or
 * a time of day such as `21:46` or `21:46:30` on `day`.
 */
const recorderTime = (day: string, value: string) => {
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);

  const full =
    clock === null
      ? value.replace(" ", "T")
      : `${day}T${clock[1]?.padStart(2, "0")}:${clock[2]}:${clock[3] ?? "00"}`;

  return decodeTime(full).pipe(
    Effect.mapError(
      () =>
        new RecorderError({
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
    const begin = yield* recorderTime(day, options.from);
    const end = yield* recorderTime(day, options.to);

    if (end <= begin) {
      return yield* new RecorderError({
        message: "--to must come after --from",
      });
    }

    const id = yield* resolveCamera(options.camera);

    const response = yield* (yield* Recorder).call((api) =>
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
          new RecorderError({
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
        command: ["kestrel", operation.name],
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
    device,
    cameras,
    recordings,
    download,
    days,
    events,
    agent,
    mcp,
  ]),
);

cli.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(Layer.mergeAll(Recorder.layer, BunServices.layer)),
  BunRuntime.runMain,
);
