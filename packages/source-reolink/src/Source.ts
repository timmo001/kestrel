/**
 * A Reolink camera, or a Reolink hub or recorder with a camera on each
 * channel, as a source, through the HTTP API it serves at
 * `/cgi-bin/api.cgi`, following the open-source reolink_aio client. It logs
 * in for a token, finds its channels and their RTSP streams, and reads each
 * camera's motion and detection state every couple of seconds, passing each
 * change on as an event. Stills come from its `Snap` command, and its
 * details from its device and disk info. Its recordings aren't read yet.
 *
 * @module
 */
import {
  cameraId,
  cameraParts,
  InvalidSettings,
  SourceUnavailable,
  UnknownCamera,
  type CameraEvent,
  type CameraId,
  type CameraInfo,
  type Connection,
  type EventKind,
  type Kind,
  type LiveFeed,
  type Source,
  type SourceSettings,
  type StillPicture,
} from "@timmo001/kestrel-core";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Option,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

/** How often each camera's motion and detection state is read. */
const pollEvery = Duration.seconds(2);

/** How long a request has to be answered. */
const requestTimeout = Duration.seconds(10);

/** How many events the source keeps for a page that opens later. */
const keptEvents = 200;

/** How long before its token runs out that a new one is asked for, in milliseconds. */
const renewBefore = 60_000;

const retry = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

/** The device types that have a camera on each channel, rather than being one. */
const recorderTypes = ["NVR", "WIFI_NVR", "HOMEHUB"];

/** What each of its detections is called as an event. */
const detections = new Map<string, EventKind>([
  ["people", "person"],
  ["vehicle", "vehicle"],
  ["dog_cat", "animal"],
]);

const ReolinkSettings = Schema.Struct({
  host: Schema.String,
  username: Schema.String,
  password: Schema.String,
});

const decodeSettings = Schema.decodeUnknownEffect(ReolinkSettings);

/** One command's answer: its value, or why it was refused. */
const Reply = Schema.Struct({
  cmd: Schema.String,
  code: Schema.Number,
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      rspCode: Schema.Number,
      detail: Schema.optional(Schema.String),
    }),
  ),
});

interface Reply extends Schema.Schema.Type<typeof Reply> {}

const decodeReplies = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Reply)),
);

const Login = Schema.Struct({
  Token: Schema.Struct({ name: Schema.String, leaseTime: Schema.Number }),
});

const DevInfo = Schema.Struct({
  DevInfo: Schema.Struct({
    name: Schema.String,
    model: Schema.String,
    firmVer: Schema.String,
    hardVer: Schema.optional(Schema.String),
    channelNum: Schema.Number,
    type: Schema.optional(Schema.String),
    exactType: Schema.optional(Schema.String),
  }),
});

const ChannelStatus = Schema.Struct({
  status: Schema.Array(
    Schema.Struct({
      channel: Schema.Number,
      online: Schema.Number,
      name: Schema.optional(Schema.String),
    }),
  ),
});

const RtspUrl = Schema.Struct({
  rtspUrl: Schema.Struct({
    mainStream: Schema.String,
    subStream: Schema.String,
  }),
});

const MdState = Schema.Struct({ state: Schema.Number });

/** Each detection's state: a number on older firmware, or whether it's supported and alarming. */
const OldState = Schema.Number;

const isOldState = Schema.is(OldState);

const AiState = Schema.Record(
  Schema.String,
  Schema.Union([
    OldState,
    Schema.Struct({ alarm_state: Schema.Number, support: Schema.Number }),
  ]),
);

const HddInfo = Schema.Struct({
  HddInfo: Schema.Array(
    Schema.Struct({
      capacity: Schema.Number,
      size: Schema.Number,
      format: Schema.Number,
      mount: Schema.Number,
      storageType: Schema.optional(Schema.Number),
    }),
  ),
});

/** The token's gone, so it needs to log in again. */
class LoginNeeded extends Schema.TaggedError<LoginNeeded>()(
  "LoginNeeded",
  {},
) {}

/** A command's parameters, such as `{ channel: 0 }`. */
interface Param {
  readonly [key: string]: string | number | Param;
}

interface Command {
  readonly cmd: string;
  readonly action: number;
  readonly param: Param;
}

const command = (cmd: string, param: Param = {}): Command => ({
  cmd,
  action: 0,
  param,
});

const loginLost = (reply: Reply) =>
  reply.code !== 0 &&
  (reply.error?.rspCode === -6 || reply.error?.detail === "please login first");

/** One of its channels, from 0, and where go2rtc reads its streams. */
interface Channel {
  readonly channel: number;
  readonly name: string;
  readonly online: boolean;
  readonly main: Redacted.Redacted;
  readonly sub: Redacted.Redacted;
}

interface Device {
  readonly name: string;
  readonly model: string;
  readonly firmware: string;
  readonly hardware: string | null;
  /** A hub or recorder, with a camera per channel, rather than a camera. */
  readonly recorder: boolean;
  readonly channels: ReadonlyArray<Channel>;
}

/** What the app shows when you add or change a Reolink device. */
export const info: Kind["info"] = {
  kind: "reolink",
  name: "Reolink",
  description:
    "A Reolink camera, or a Reolink hub or recorder with its cameras: live view, stills, motion and detections",
  fields: [
    {
      key: "host",
      label: "Address",
      type: "text",
      required: true,
      hint: "Its address on your network, such as 192.0.2.30; start it with https:// where its HTTP port is off",
    },
    {
      key: "username",
      label: "Username",
      type: "text",
      required: true,
      hint: null,
    },
    {
      key: "password",
      label: "Password",
      type: "secret",
      required: true,
      hint: null,
    },
  ],
  cameraFields: null,
};

/** A Reolink device as a source, logged in for as long as the scope lasts. */
export const make = Effect.fnUntraced(function* (saved: SourceSettings) {
  const id = saved.id;
  const name = saved.name;

  const invalid = (message: string) =>
    new InvalidSettings({ message: `${name}: ${message}` });

  // A field left empty on the page counts as left out
  const settings = yield* decodeSettings(
    Object.fromEntries(
      Object.entries(saved.settings).filter(([, value]) => value !== ""),
    ),
  ).pipe(
    Effect.mapError(() =>
      invalid("it needs an address, a username and a password"),
    ),
  );

  const address = settings.host.includes("://")
    ? settings.host
    : `http://${settings.host}`;

  if (!URL.canParse(address)) {
    return yield* invalid(`${settings.host} isn't an address`);
  }

  const base = new URL(address);
  const api = new URL("/cgi-bin/api.cgi", base).href;
  const username = Redacted.make(settings.username);
  const password = Redacted.make(settings.password);

  const unavailable = (message: string) =>
    new SourceUnavailable({ message: `${name} ${message}` });

  // It answers one request at a time, as reolink_aio sends them
  const sending = yield* Semaphore.make(1);

  /** One request, read as `read` says; its HTTPS certificate is its own, so it isn't checked. */
  const send = <A>(
    query: URLSearchParams,
    init: RequestInit,
    read: (response: Response) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${api}?${query.toString()}`, {
          ...init,
          signal,
          tls: { rejectUnauthorized: false },
        });

        if (!response.ok) throw new Error(`it answered ${response.status}`);

        return await read(response);
      },
      // The query holds its token, so it's left out of the message
      catch: (error) =>
        unavailable(
          `can't be reached${error instanceof Error ? `: ${error.message}` : ""}`,
        ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () => Effect.fail(unavailable("didn't answer in time")),
      }),
      (effect) => sending.withPermit(effect),
    );

  const text = (response: Response) => response.text();

  const replies = (body: string) =>
    decodeReplies(body).pipe(
      Effect.mapError(() => unavailable("didn't answer as its API does")),
    );

  /** Commands sent together with a token, and their answers in order. */
  const post = (commands: ReadonlyArray<Command>, token: string) =>
    send(
      new URLSearchParams({ token }),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(commands),
      },
      text,
    ).pipe(
      Effect.flatMap(replies),
      Effect.flatMap((list) =>
        list.some(loginLost)
          ? Effect.fail(new LoginNeeded())
          : Effect.succeed(list),
      ),
    );

  /** The value of the answer at `at`, decoded, or why there isn't one. */
  const valueOf = <S extends Schema.ConstraintDecoder<unknown>>(
    list: ReadonlyArray<Reply>,
    at: number,
    schema: S,
  ): Effect.Effect<S["Type"], SourceUnavailable> => {
    const reply = list[at];

    if (reply === undefined) {
      return Effect.fail(unavailable("left a command unanswered"));
    }

    if (reply.code !== 0) {
      return Effect.fail(
        unavailable(
          `refused ${reply.cmd}${reply.error?.detail === undefined ? "" : `: ${reply.error.detail}`}`,
        ),
      );
    }

    return Schema.decodeUnknownEffect(schema)(reply.value).pipe(
      Effect.mapError(() =>
        unavailable(`answered ${reply.cmd} in a way Kestrel doesn't know`),
      ),
    );
  };

  const session = yield* Ref.make(
    Option.none<{ readonly token: string; readonly until: number }>(),
  );

  const logins = yield* Semaphore.make(1);

  const login = Effect.gen(function* () {
    const list = yield* send(
      new URLSearchParams({ cmd: "Login", token: "null" }),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          command("Login", {
            User: {
              Version: "0",
              userName: Redacted.value(username),
              password: Redacted.value(password),
            },
          }),
        ]),
      },
      text,
    ).pipe(Effect.flatMap(replies));

    const value = yield* valueOf(list, 0, Login).pipe(
      Effect.mapError(() => unavailable("refused its username or password")),
    );

    const opened = {
      token: value.Token.name,
      until: (yield* Clock.currentTimeMillis) + value.Token.leaseTime * 1000,
    };

    yield* Ref.set(session, Option.some(opened));

    return opened.token;
  });

  /** Its token, logging in when there's none or it's about to run out. */
  const token = logins.withPermit(
    Effect.gen(function* () {
      const open = yield* Ref.get(session);
      const now = yield* Clock.currentTimeMillis;

      if (Option.isSome(open) && open.value.until - renewBefore > now) {
        return open.value.token;
      }

      return yield* login;
    }),
  );

  /** Runs `use` with its token, logging in again once if the token's gone. */
  const withToken = <A, E>(
    use: (token: string) => Effect.Effect<A, E | LoginNeeded>,
  ) => {
    const once = token.pipe(Effect.flatMap(use));

    return once.pipe(
      Effect.catchTag("LoginNeeded", () =>
        Ref.set(session, Option.none()).pipe(Effect.andThen(once)),
      ),
      Effect.catchTag("LoginNeeded", () =>
        Effect.fail(unavailable("keeps asking to log in again")),
      ),
    );
  };

  const call = (commands: ReadonlyArray<Command>) =>
    withToken((value) => post(commands, value));

  /** A stream address with its login in it. */
  const withLogin = (stream: string) => {
    const url = new URL(stream);

    url.username = Redacted.value(username);
    url.password = Redacted.value(password);

    return Redacted.make(url.href);
  };

  /** Where a channel's stream is when it doesn't say, as reolink_aio falls back to. */
  const fallback = (channel: number, stream: "main" | "sub") =>
    withLogin(
      `rtsp://${base.hostname}:554/h264Preview_${String(channel + 1).padStart(2, "0")}_${stream}`,
    );

  /** Its device info, its channels and their streams. */
  const discover = Effect.gen(function* () {
    const first = yield* call([
      command("GetDevInfo"),
      command("GetChannelstatus"),
    ]);

    const device = (yield* valueOf(first, 0, DevInfo)).DevInfo;

    const status = yield* valueOf(first, 1, ChannelStatus).pipe(Effect.option);

    const recorder = [device.type, device.exactType].some(
      (type) => type !== undefined && recorderTypes.includes(type),
    );

    const found = Option.match(status, {
      onNone: () =>
        Array.from({ length: device.channelNum }, (_, channel) => ({
          channel,
          online: true,
          name: undefined,
        })),
      onSome: (value) =>
        value.status.map((each) => ({
          channel: each.channel,
          online: each.online === 1,
          name: each.name,
        })),
    });

    const urls = yield* call(
      found.map((each) => command("GetRtspUrl", { channel: each.channel })),
    ).pipe(Effect.option);

    const channels = yield* Effect.forEach(
      found,
      Effect.fnUntraced(function* (each, at) {
        const url = Option.isSome(urls)
          ? yield* valueOf(urls.value, at, RtspUrl).pipe(Effect.option)
          : Option.none();

        // A channel's own name is "0" or "1" on some firmware
        const own =
          each.name === undefined || each.name === "0" || each.name === "1"
            ? null
            : each.name;

        return {
          channel: each.channel,
          name: recorder
            ? (own ?? `Channel ${each.channel + 1}`)
            : (own ?? device.name),
          online: each.online,
          main: Option.match(url, {
            onNone: () => fallback(each.channel, "main"),
            onSome: (value) => withLogin(value.rtspUrl.mainStream),
          }),
          sub: Option.match(url, {
            onNone: () => fallback(each.channel, "sub"),
            onSome: (value) => withLogin(value.rtspUrl.subStream),
          }),
        };
      }),
    );

    return {
      name: device.name,
      model: device.model,
      firmware: device.firmVer,
      hardware: device.hardVer ?? null,
      recorder,
      channels,
    } satisfies Device;
  });

  const current = yield* Ref.make(Option.none<Device>());

  const connection = yield* Ref.make<Connection>({
    connected: false,
    since: null,
    error: null,
  });

  const recent = yield* Ref.make<ReadonlyArray<CameraEvent>>([]);
  const events = yield* PubSub.sliding<CameraEvent>(256);

  // Each camera's last state, by channel and kind, and whether there's motion now
  const seen = new Map<string, boolean>();
  const motion = new Map<number, boolean>();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const cameraOf = (channel: Channel) =>
    cameraId(id, String(channel.channel + 1));

  /** Passes on a state that changed, or one that's on at the first read. */
  const changed = Effect.fnUntraced(function* (
    channel: Channel,
    kind: EventKind,
    active: boolean,
  ) {
    const key = `${channel.channel}:${kind}`;
    const before = seen.get(key);

    seen.set(key, active);

    if (before === undefined ? !active : before === active) return;

    const event: CameraEvent = {
      source: id,
      camera: cameraOf(channel),
      kind,
      active,
      time: null,
      receivedAt: yield* now,
    };

    yield* Ref.update(recent, (list) => [event, ...list].slice(0, keptEvents));
    yield* PubSub.publish(events, event);
  });

  /** Each camera's motion and detections now. */
  const readState = Effect.fnUntraced(function* (device: Device) {
    const list = yield* call(
      device.channels.flatMap((channel) => [
        command("GetMdState", { channel: channel.channel }),
        command("GetAiState", { channel: channel.channel }),
      ]),
    );

    yield* Effect.forEach(
      device.channels,
      Effect.fnUntraced(function* (channel, at) {
        const md = yield* valueOf(list, at * 2, MdState).pipe(Effect.option);

        // Cameras without detection refuse GetAiState
        const ai = yield* valueOf(list, at * 2 + 1, AiState).pipe(
          Effect.option,
        );

        if (Option.isSome(md)) {
          motion.set(channel.channel, md.value.state === 1);
          yield* changed(channel, "motion", md.value.state === 1);
        }

        if (Option.isNone(ai)) return;

        for (const [key, value] of Object.entries(ai.value)) {
          const kind = detections.get(key);

          if (kind === undefined) continue;

          if (isOldState(value)) {
            yield* changed(channel, kind, value === 1);
          } else if (value.support === 1) {
            yield* changed(channel, kind, value.alarm_state === 1);
          }
        }
      }),
    );
  });

  // Logs out when it stops, so it doesn't run out of sessions
  yield* Effect.addFinalizer(() =>
    Ref.get(session).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (open) =>
            post([command("Logout")], open.token).pipe(Effect.ignore),
        }),
      ),
    ),
  );

  yield* Effect.gen(function* () {
    const device = yield* discover;

    yield* Ref.set(current, Option.some(device));

    yield* Ref.set(connection, {
      connected: true,
      since: yield* now,
      error: null,
    });

    yield* Effect.logInfo(`Logged in to ${device.model} (${device.firmware})`);

    return yield* readState(device).pipe(
      Effect.repeat(Schedule.spaced(pollEvery)),
    );
  }).pipe(
    Effect.ensuring(Ref.set(current, Option.none())),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        yield* Ref.set(connection, {
          connected: false,
          since: yield* now,
          error: error.message,
        });

        yield* Effect.logWarning(`${name} stopped answering: ${error.message}`);
      }),
    ),
    Effect.retry(retry),
    Effect.forkScoped,
  );

  /** What it found, or why it hasn't yet. */
  const opened = Ref.get(current).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(unavailable("isn't logged in to yet")),
        onSome: (device) => Effect.succeed(device),
      }),
    ),
  );

  const channelOf = (device: Device, camera: CameraId) => {
    const parts = cameraParts(camera);

    const found = device.channels.find(
      (each) =>
        parts.source === id && String(each.channel + 1) === parts.camera,
    );

    return found === undefined
      ? Effect.fail(
          new UnknownCamera({ message: `${name} has no camera ${camera}` }),
        )
      : Effect.succeed(found);
  };

  const snap = (channel: Channel) =>
    withToken((value) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) =>
          send(
            new URLSearchParams({
              cmd: "Snap",
              channel: String(channel.channel),
              rs: String(at),
              token: value,
            }),
            {},
            async (response): Promise<StillPicture> => ({
              data: new Uint8Array(await response.arrayBuffer()),
              contentType: response.headers.get("content-type") ?? "",
            }),
          ),
        ),
        // It answers with an error in JSON in place of a picture, most
        // often for a token that's gone
        Effect.flatMap((picture) =>
          picture.contentType.startsWith("image/")
            ? Effect.succeed(picture)
            : Effect.fail(new LoginNeeded()),
        ),
      ),
    );

  const source: Source = {
    id,
    kind: "reolink",
    name,
    connection: Ref.get(connection),
    attention: Ref.get(connection).pipe(
      Effect.map((state) =>
        state.connected || state.since === null
          ? []
          : [
              {
                source: id,
                level: "alert",
                kind: "connection",
                message: `Can't reach ${name}${state.error === null ? "" : `: ${state.error}`}`,
              },
            ],
      ),
    ),
    cameras: opened.pipe(
      Effect.map((device) =>
        device.channels.map((channel): CameraInfo => ({
          id: cameraOf(channel),
          name: channel.name,
          channel: device.recorder ? channel.channel + 1 : null,
          signal: channel.online,
          live: true,
          still: true,
          recordings: false,
          events: true,
        })),
      ),
    ),
    live: opened.pipe(
      Effect.map((device) =>
        device.channels.map((channel): LiveFeed => ({
          camera: cameraOf(channel),
          main: channel.main,
          sub: channel.sub,
        })),
      ),
    ),
    stills: {
      still: Effect.fnUntraced(function* (camera) {
        const device = yield* opened;
        const channel = yield* channelOf(device, camera);

        return yield* snap(channel);
      }),
    },
    events: {
      recent: Ref.get(recent),
      live: Stream.fromPubSub(events),
    },
    details: Effect.gen(function* () {
      const device = yield* opened;

      const disks = yield* call([command("GetHddInfo")]).pipe(
        Effect.flatMap((list) => valueOf(list, 0, HddInfo)),
        Effect.option,
      );

      return {
        clock: null,
        facts: [
          { label: "Name", value: device.name },
          { label: "Model", value: device.model },
          { label: "Firmware", value: device.firmware },
          ...(device.hardware === null
            ? []
            : [{ label: "Hardware", value: device.hardware }]),
          ...(device.recorder
            ? [{ label: "Channels", value: String(device.channels.length) }]
            : []),
        ],
        storage: Option.match(disks, {
          onNone: () => [],
          onSome: (value) =>
            value.HddInfo.map((disk, at) => {
              const ready = disk.mount === 1 && disk.format === 1;

              return {
                name: `${disk.storageType === 1 ? "Disk" : "SD card"} ${at + 1}`,
                state: ready
                  ? `${Math.round(100 * (1 - disk.size / Math.max(disk.capacity, 1)))}% used`
                  : disk.format === 1
                    ? "not mounted"
                    : "not formatted",
                ok: ready,
              };
            }),
        }),
        cameras: device.channels.map((channel) => ({
          camera: cameraOf(channel),
          signal: channel.online,
          recording: "unknown",
          motion: motion.get(channel.channel) ?? null,
        })),
      };
    }),
  };

  return source;
});
