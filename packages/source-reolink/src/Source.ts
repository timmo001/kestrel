/**
 * A Reolink camera, or a Reolink hub or recorder with a camera on each
 * channel, as a source, through the HTTP API it serves at
 * `/cgi-bin/api.cgi`, following the open-source reolink_aio client. It logs
 * in for a token, finds its channels and their RTSP streams, and reads each
 * camera's motion and detection state every couple of seconds, passing each
 * change on as an event. Stills come from its `Snap` command, and its
 * details from its device and disk info. A camera that pans, tilts or zooms
 * is steered with `PtzCtrl` and `StartZoomFocus`, as its `GetAbility` says
 * it can, with its presets, its home (`PtzGuard`) and how it follows what it
 * sees (`AiCfg`), and a TrackMix's telephoto lens on a hub or recorder plays as its
 * second view. Its picture settings, such as brightness, are read with
 * `GetImage` and changed with `SetImage`, where its abilities say it has
 * them. Its recordings, on an SD card or
 * a hub's disk, are listed from its `Search` command, one search per
 * request, as some firmware fails a batch. A hub or recorder hands its files
 * over by replaying them on its own protocol; a camera's are listed only, as
 * it cuts a download short and older firmware refuses a replay, so a camera
 * can instead send its clips to Kestrel by FTP as it records them.
 *
 * @module
 */
import {
  cameraId,
  cameraParts,
  InvalidSettings,
  NoRecordings,
  NotSupported,
  PictureCommand,
  PtzCommand,
  SourceUnavailable,
  UnknownCamera,
  type CameraEvent,
  type CameraId,
  type CameraInfo,
  type Connection,
  type EventKind,
  type Kind,
  type LiveFeed,
  type PictureControls,
  type PictureState,
  type PtzControls,
  type PtzHome,
  type PtzState,
  type Source,
  type SourcePicture,
  type SourcePtz,
  type SourceRecordings,
  type SourceSettings,
  type SourceUploads,
  type StillPicture,
  type TrackMethod,
  type Tracking,
  type TrackTarget,
} from "@timmo001/kestrel-core";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  FiberMap,
  Option,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { deviceReplays, type DeviceFile } from "./Replays.ts";
import {
  addressToward,
  clipStart,
  DeviceAbility,
  Ftp,
  nameOf,
  pointedAt,
  sendsTo,
  stopped,
} from "./Uploads.ts";

/** How often each camera's motion and detection state is read. */
const pollEvery = Duration.seconds(2);

/** How long a request has to be answered. */
const requestTimeout = Duration.seconds(10);

/** How many events the source keeps for a page that opens later. */
const keptEvents = 200;

/** How long before its token runs out that a new one is asked for, in milliseconds. */
const renewBefore = 60_000;

/** How long a camera keeps moving after the last word to, so a page closed mid-drag doesn't leave it turning. */
const stopAfter = Duration.seconds(1);

/** The `ptzType` versions of a camera that turns side to side, as reolink_aio reads them. */
const turns = [2, 3, 5, 6, 7];

/** PtzCtrl's op for each way, by the signs of pan and tilt, with down positive. */
const moves = new Map([
  ["-1,0", "Left"],
  ["1,0", "Right"],
  ["0,-1", "Up"],
  ["0,1", "Down"],
  ["-1,-1", "LeftUp"],
  ["-1,1", "LeftDown"],
  ["1,-1", "RightUp"],
  ["1,1", "RightDown"],
]);

/**
 * How small one way can be, as a share of the other, before it's dropped,
 * so a mostly sideways drag doesn't go off at 45°: it only moves eight ways.
 */
const offAxis = 0.4;

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
  /** What each setting can be, for a command sent with action 1. */
  range: Schema.optional(Schema.Unknown),
  /** Each setting's default, for a command sent with action 1. */
  initial: Schema.optional(Schema.Unknown),
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

/** What each channel can do, as each ability's version, 0 where it can't. */
const Ability = Schema.Struct({
  Ability: Schema.Struct({
    abilityChn: Schema.optional(
      Schema.Array(
        Schema.Record(
          Schema.String,
          Schema.Struct({ ver: Schema.optional(Schema.Number) }),
        ),
      ),
    ),
  }),
});

/** Where its lens is zoomed now. */
const ZoomFocus = Schema.Struct({
  ZoomFocus: Schema.Struct({ zoom: Schema.Struct({ pos: Schema.Number }) }),
});

const Span = Schema.Struct({ min: Schema.Number, max: Schema.Number });

/** How far its lens zooms each way. */
const ZoomRange = Schema.Struct({
  ZoomFocus: Schema.Struct({ zoom: Schema.Struct({ pos: Span }) }),
});

/** Every preset slot, set or not. */
const PtzPresets = Schema.Struct({
  PtzPreset: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      enable: Schema.Number,
      name: Schema.optional(Schema.String),
    }),
  ),
});

/** Its home, which it calls its guard point. */
const PtzGuard = Schema.Struct({
  PtzGuard: Schema.Struct({
    benable: Schema.Number,
    bexistPos: Schema.Number,
    timeout: Schema.Number,
  }),
});

/** What it follows, by its own names, 1 for each it does. */
const TrackFlags = Schema.Struct({
  people: Schema.optional(Schema.Number),
  vehicle: Schema.optional(Schema.Number),
  dog_cat: Schema.optional(Schema.Number),
});

/** How it follows what it sees. */
const AiCfg = Schema.Struct({
  bSmartTrack: Schema.optional(Schema.Number),
  aiTrack: Schema.optional(Schema.Number),
  aiDisappearBackTime: Schema.optional(Schema.Number),
  aiStopBackTime: Schema.optional(Schema.Number),
  trackType: Schema.optional(TrackFlags),
});

/** The choices it takes for each. */
const AiCfgRange = Schema.Struct({
  aiTrack: Schema.optional(Schema.Array(Schema.Number)),
  aiDisappearBackTime: Schema.optional(Schema.Array(Schema.Number)),
  trackType: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/** Its names for what it follows, by Kestrel's. */
const trackNames = [
  ["people", "people"],
  ["vehicles", "vehicle"],
  ["animals", "dog_cat"],
] as const satisfies ReadonlyArray<
  readonly [TrackTarget, keyof typeof TrackFlags.Type]
>;

/** Its `aiTrack` numbers for each way it follows, as reolink_aio has them. */
const trackMethods = [
  ["digital", 2],
  ["digital-first", 3],
  ["turn-first", 4],
] as const satisfies ReadonlyArray<readonly [TrackMethod, number]>;

/** Its picture settings, by its own names, such as `bright`. */
const Image = Schema.Struct({
  Image: Schema.Record(Schema.String, Schema.Number),
});

/** What each picture setting can be, with its channel among them. */
const ImageRange = Schema.Struct({
  Image: Schema.Record(Schema.String, Schema.Unknown),
});

const isSpan = Schema.is(Span);

/**
 * Its names for each picture setting by Kestrel's, and the ability that
 * says it has it, as reolink_aio reads them, `ispSatruation` misspelt as
 * the firmware has it.
 */
const pictureNames = [
  ["hue", "hue", "ispHue"],
  ["brightness", "bright", "ispBright"],
  ["contrast", "contrast", "ispContrast"],
  ["saturation", "saturation", "ispSatruation"],
  ["sharpness", "sharpen", "ispSharpen"],
] as const satisfies ReadonlyArray<
  readonly [keyof PictureState, string, string]
>;

type PictureName = (typeof pictureNames)[number][0];

/** One picture setting a channel has: its own name, its range and its default where it says. */
interface ImageSetting {
  readonly own: string;
  readonly min: number;
  readonly max: number;
  readonly initial: number | undefined;
}

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

const ReolinkTime = Schema.Struct({
  year: Schema.Number,
  mon: Schema.Number,
  day: Schema.Number,
  hour: Schema.Number,
  min: Schema.Number,
  sec: Schema.Number,
});

interface ReolinkTime extends Schema.Schema.Type<typeof ReolinkTime> {}

/** The days of a month with recordings, as a `0` or `1` for each day. */
const SearchStatus = Schema.Struct({
  SearchResult: Schema.Struct({
    Status: Schema.optional(
      Schema.Array(
        Schema.Struct({
          year: Schema.Number,
          mon: Schema.Number,
          table: Schema.String,
        }),
      ),
    ),
  }),
});

/** The files on a day; a hub sends their sizes as strings. */
const SearchFiles = Schema.Struct({
  SearchResult: Schema.Struct({
    File: Schema.optional(
      Schema.Array(
        Schema.Struct({
          StartTime: ReolinkTime,
          EndTime: ReolinkTime,
          size: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
          /** Its path on the device, which a replay asks for. */
          name: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
});

const two = (value: number) => String(value).padStart(2, "0");

/** A Reolink time as a local time, such as `2026-11-12T14:02:33`. */
const localTimeOf = (time: ReolinkTime) =>
  `${time.year}-${two(time.mon)}-${two(time.day)}T${two(time.hour)}:${two(time.min)}:${two(time.sec)}`;

/** A local date, such as `2026-11-12`, at a time of day. */
const reolinkTime = (date: string, hour: number, min: number, sec: number) => {
  const [year = 0, mon = 0, day = 0] = date.split("-").map(Number);

  return { year, mon, day, hour, min, sec };
};

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

const command = (cmd: string, param: Param = {}, action = 0): Command => ({
  cmd,
  action,
  param,
});

const loginLost = (reply: Reply) =>
  reply.code !== 0 &&
  (reply.error?.rspCode === -6 || reply.error?.detail === "please login first");

/** A channel's own name, or `null` where it has none: firmware sends "0" or "1" for that. */
const ownName = (name: string | undefined) =>
  name === undefined || name === "" || name === "0" || name === "1"
    ? null
    : name;

/** One of its channels, from 0, and where go2rtc reads its streams. */
interface Channel {
  readonly channel: number;
  readonly name: string;
  readonly online: boolean;
  readonly main: Redacted.Redacted;
  readonly sub: Redacted.Redacted;
  /** How it moves and zooms; `null` where it does neither. */
  readonly ptz: PtzControls | null;
  /** Whether PtzCtrl takes a speed for it. */
  readonly speed: boolean;
  /** How far its lens zooms each way, where it zooms. */
  readonly zoom: typeof Span.Type | null;
  /** Its telephoto lens's stream, for a TrackMix on a hub or recorder. */
  readonly telephoto: Redacted.Redacted | null;
  /** Which picture settings it has; `null` where it has none. */
  readonly picture: PictureControls | null;
  /** Each picture setting it has. */
  readonly image: ReadonlyMap<PictureName, ImageSetting>;
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

  const replays = yield* deviceReplays({
    name,
    host: base.hostname,
    username,
    password,
  });

  // Only a hub or recorder replays its files, which isn't known until it answers
  let replaying = false;

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

  /** The value of the answer at `at`, or its range, decoded, or why there isn't one. */
  const valueOf = <S extends Schema.ConstraintDecoder<unknown>>(
    list: ReadonlyArray<Reply>,
    at: number,
    schema: S,
    field: "value" | "range" | "initial" = "value",
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

    return Schema.decodeUnknownEffect(schema)(reply[field]).pipe(
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
      // A hub or recorder lists every slot; an empty one is offline with no
      // name, while a sleeping camera keeps its name
      onSome: (value) =>
        value.status.flatMap((each) =>
          each.online === 1 || ownName(each.name) !== null
            ? [
                {
                  channel: each.channel,
                  online: each.online === 1,
                  name: each.name,
                },
              ]
            : [],
        ),
    });

    const urls = yield* call(
      found.map((each) => command("GetRtspUrl", { channel: each.channel })),
    ).pipe(Effect.option);

    // reolink_aio sends its username with this; older firmware refuses it
    const abilities = yield* call([
      command("GetAbility", { User: { userName: Redacted.value(username) } }),
    ]).pipe(
      Effect.flatMap((list) => valueOf(list, 0, Ability)),
      Effect.map((value) => value.Ability.abilityChn ?? []),
      Effect.orElseSucceed(() => []),
    );

    /** A channel's version of an ability, or `missing` where it doesn't say. */
    const versionOf = (channel: number, key: string, missing = 0) =>
      abilities[channel]?.[key]?.ver ?? missing;

    // These ptzType versions zoom optically, as reolink_aio reads them
    const zooming = found.filter(
      (each) =>
        [1, 2, 5].includes(versionOf(each.channel, "ptzType")) ||
        versionOf(each.channel, "supportDigitalZoom") > 0,
    );

    const zoomRanges = new Map<number, typeof Span.Type>();

    if (zooming.length > 0) {
      const ranges = yield* call(
        zooming.map((each) =>
          command("GetZoomFocus", { channel: each.channel }, 1),
        ),
      ).pipe(Effect.option);

      if (Option.isSome(ranges)) {
        yield* Effect.forEach(
          zooming,
          Effect.fnUntraced(function* (each, at) {
            const range = yield* valueOf(
              ranges.value,
              at,
              ZoomRange,
              "range",
            ).pipe(Effect.option);

            if (
              Option.isSome(range) &&
              range.value.ZoomFocus.zoom.pos.max >
                range.value.ZoomFocus.zoom.pos.min
            ) {
              zoomRanges.set(each.channel, range.value.ZoomFocus.zoom.pos);
            }
          }),
        );
      }
    }

    // Its home has no ability of its own, so a camera that turns is asked
    // for it, as reolink_aio does
    const turning = found.filter((each) =>
      turns.includes(versionOf(each.channel, "ptzType")),
    );

    const guards =
      turning.length === 0
        ? Option.none()
        : yield* call(
            turning.map((each) =>
              command("GetPtzGuard", { channel: each.channel }),
            ),
          ).pipe(Effect.option);

    const homes = Option.match(guards, {
      onNone: (): ReadonlyArray<number> => [],
      onSome: (list) =>
        turning
          .filter((_, at) => list[at]?.code === 0)
          .map((each) => each.channel),
    });

    // Its picture settings' ranges and defaults, once, as they don't change
    const imaging = found.filter((each) =>
      pictureNames.some(
        ([, , ability]) => versionOf(each.channel, ability) > 0,
      ),
    );

    const images = new Map<
      number,
      {
        readonly range: Option.Option<typeof ImageRange.Type>;
        readonly initial: Option.Option<typeof Image.Type>;
      }
    >();

    if (imaging.length > 0) {
      const list = yield* call(
        imaging.map((each) =>
          command("GetImage", { channel: each.channel }, 1),
        ),
      ).pipe(Effect.option);

      if (Option.isSome(list)) {
        yield* Effect.forEach(
          imaging,
          Effect.fnUntraced(function* (each, at) {
            images.set(each.channel, {
              range: yield* valueOf(list.value, at, ImageRange, "range").pipe(
                Effect.option,
              ),
              initial: yield* valueOf(list.value, at, Image, "initial").pipe(
                Effect.option,
              ),
            });
          }),
        );
      }
    }

    /** Each picture setting a channel has, 0 to 255 where it doesn't say. */
    const imageOf = (channel: number) => {
      const read = images.get(channel);

      return new Map(
        pictureNames.flatMap(([setting, own, ability]) => {
          if (versionOf(channel, ability) === 0) return [];

          const span = Option.getOrUndefined(
            Option.map(
              read?.range ?? Option.none(),
              (value) => value.Image[own],
            ),
          );

          const initial = Option.getOrUndefined(
            Option.map(
              read?.initial ?? Option.none(),
              (value) => value.Image[own],
            ),
          );

          const known = isSpan(span) && span.max > span.min;

          return [
            [
              setting,
              {
                own,
                min: known ? span.min : 0,
                max: known ? span.max : 255,
                initial,
              },
            ] as const,
          ];
        }),
      );
    };

    const channels = yield* Effect.forEach(
      found,
      Effect.fnUntraced(function* (each, at) {
        const url = Option.isSome(urls)
          ? yield* valueOf(urls.value, at, RtspUrl).pipe(Effect.option)
          : Option.none();

        const own = ownName(each.name);
        const ptzType = versionOf(each.channel, "ptzType");
        const zoom = zoomRanges.get(each.channel) ?? null;
        const pan = turns.includes(ptzType);
        const tilt = [2, 3, 5, 6].includes(ptzType);
        const image = imageOf(each.channel);

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
          ptz:
            pan || tilt || zoom !== null
              ? {
                  pan,
                  tilt,
                  zoom: zoom !== null,
                  presets: pan && versionOf(each.channel, "ptzPreset") > 0,
                  home: homes.includes(each.channel),
                  tracking: versionOf(each.channel, "aiTrack") > 0,
                }
              : null,
          speed:
            [2, 3].includes(ptzType) &&
            versionOf(each.channel, "supportPtzSpeed", 1) > 0,
          zoom,
          // reolink_aio only finds a TrackMix's second lens like this on a hub or recorder
          telephoto:
            recorder && versionOf(each.channel, "supportAutoTrackStream") > 0
              ? withLogin(
                  `rtsp://${base.hostname}:554/Preview_${two(each.channel + 1)}_autotrack`,
                )
              : null,
          picture:
            image.size === 0
              ? null
              : {
                  hue: image.has("hue"),
                  brightness: image.has("brightness"),
                  contrast: image.has("contrast"),
                  saturation: image.has("saturation"),
                  sharpness: image.has("sharpness"),
                  // Only where it said every one's default
                  reset: [...image.values()].every(
                    (setting) => setting.initial !== undefined,
                  ),
                },
          image,
        } satisfies Channel;
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

    replaying = device.recorder;
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

  /** A Reolink time as a command parameter. */
  const timeParam = (time: ReolinkTime): Param => ({
    year: time.year,
    mon: time.mon,
    day: time.day,
    hour: time.hour,
    min: time.min,
    sec: time.sec,
  });

  /** One search, sent alone: some firmware fails a batch of them. */
  const search = (
    channel: Channel,
    onlyStatus: number,
    from: ReolinkTime,
    to: ReolinkTime,
  ) =>
    call([
      command("Search", {
        Search: {
          channel: channel.channel,
          onlyStatus,
          streamType: "main",
          StartTime: timeParam(from),
          EndTime: timeParam(to),
        },
      }),
    ]);

  /** A channel's files on a day, as its search lists them. */
  const filesOn = (channel: Channel, date: string) =>
    search(
      channel,
      0,
      reolinkTime(date, 0, 0, 0),
      reolinkTime(date, 23, 59, 59),
    ).pipe(
      Effect.flatMap((list) => valueOf(list, 0, SearchFiles)),
      Effect.map((value) => value.SearchResult.File ?? []),
    );

  const listing = {
    days: Effect.fnUntraced(function* (month) {
      const device = yield* opened;
      const [year = 0, mon = 0] = month.split("-").map(Number);
      const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();

      const found = yield* Effect.forEach(device.channels, (channel) =>
        search(
          channel,
          1,
          reolinkTime(`${month}-01`, 0, 0, 0),
          reolinkTime(`${month}-${two(last)}`, 23, 59, 59),
        ).pipe(Effect.flatMap((list) => valueOf(list, 0, SearchStatus))),
      );

      const dates = new Set(
        found.flatMap((value) =>
          (value.SearchResult.Status ?? []).flatMap((status) =>
            status.table
              .split("")
              .flatMap((flag, at) =>
                flag === "1"
                  ? [`${status.year}-${two(status.mon)}-${two(at + 1)}`]
                  : [],
              ),
          ),
        ),
      );

      // Its search doesn't say why, and these record on events
      return [...dates].toSorted().map((date) => ({
        date,
        reasons: ["motion" as const],
      }));
    }),
    list: Effect.fnUntraced(function* (camera, date) {
      const device = yield* opened;
      const channel = yield* channelOf(device, camera);
      const files = yield* filesOn(channel, date);

      return files.map((file) => ({
        camera,
        begin: localTimeOf(file.StartTime),
        end: localTimeOf(file.EndTime),
        reasons: ["motion" as const],
        bytes: file.size === undefined ? null : Number(file.size),
      }));
    }),
  } satisfies SourceRecordings;

  /** Its main stream's files, replayed; those are the files its search lists. */
  const video: NonNullable<SourceRecordings["video"]> = Effect.fnUntraced(
    function* (options) {
      const device = yield* opened;
      const channel = yield* channelOf(device, options.camera);

      const dates = new Set(
        [options.begin, options.end].map((time) => time.slice(0, 10)),
      );

      const found = yield* Effect.forEach(dates, (date) =>
        filesOn(channel, date),
      );

      // A file that runs past midnight is listed on both days
      const files = new Map<string, DeviceFile>();

      for (const file of found.flat()) {
        const begin = localTimeOf(file.StartTime);
        const end = localTimeOf(file.EndTime);

        if (
          file.name !== undefined &&
          begin < options.end &&
          end > options.begin
        ) {
          files.set(file.name, { name: file.name, begin, end });
        }
      }

      if (files.size === 0) {
        return yield* new NoRecordings({
          message: `Nothing was recorded on ${options.camera} from ${options.begin} to ${options.end}`,
        });
      }

      return replays.video({
        channel: channel.channel,
        files: [...files.values()].toSorted((a, b) =>
          a.begin.localeCompare(b.begin),
        ),
        begin: options.begin,
        end: options.end,
        every: options.every,
        pace: options.pace,
      });
    },
  );

  /** Each camera's watch that stops it moving once the page stops saying so, by channel. */
  const moving = yield* FiberMap.make<number>();

  /** A camera that moves or zooms. */
  const steerable = Effect.fnUntraced(function* (camera: CameraId) {
    const device = yield* opened;
    const channel = yield* channelOf(device, camera);

    if (channel.ptz === null) {
      return yield* new NotSupported({
        message: `${camera} doesn't move or zoom`,
      });
    }

    return { channel, ptz: channel.ptz };
  });

  /** One command that changes something, failing where the camera refuses it. */
  const setting = (cmd: string, param: Param) =>
    call([command(cmd, param)]).pipe(
      Effect.flatMap((list) => valueOf(list, 0, Schema.Unknown)),
      Effect.asVoid,
    );

  /**
   * One PtzCtrl, such as `{ op: "Left" }`, at `speed` (1 to 64) where the
   * camera takes one.
   */
  const ptzCtrl = (channel: Channel, param: Param, speed?: number) => {
    const plain = { channel: channel.channel, ...param };

    const sent: Param =
      speed !== undefined && channel.speed ? { ...plain, speed } : plain;

    return setting("PtzCtrl", sent);
  };

  const stop = (channel: Channel) =>
    FiberMap.remove(moving, channel.channel).pipe(
      Effect.andThen(ptzCtrl(channel, { op: "Stop" })),
    );

  /** Every preset slot, set or not. */
  const slotsOf = (channel: Channel) =>
    call([command("GetPtzPreset", { channel: channel.channel })]).pipe(
      Effect.flatMap((list) => valueOf(list, 0, PtzPresets)),
      Effect.map((value) => value.PtzPreset),
    );

  const homeOf = (channel: Channel) =>
    call([command("GetPtzGuard", { channel: channel.channel })]).pipe(
      Effect.flatMap((list) => valueOf(list, 0, PtzGuard)),
      Effect.map(({ PtzGuard: guard }): PtzHome => ({
        on: guard.benable === 1,
        set: guard.bexistPos === 1,
        backAfter: guard.timeout,
      })),
    );

  const trackingOf = Effect.fnUntraced(function* (channel: Channel) {
    const list = yield* call([
      command("GetAiCfg", { channel: channel.channel }, 1),
    ]);

    const value = yield* valueOf(list, 0, AiCfg);

    const range = yield* valueOf(list, 0, AiCfgRange, "range").pipe(
      Effect.orElseSucceed((): typeof AiCfgRange.Type => ({})),
    );

    const offered = range.trackType ?? value.trackType ?? {};

    return {
      // Older firmware has no switch of its own, and turns it on as a way
      on: (value.bSmartTrack ?? (value.aiTrack === 1 ? 1 : 0)) === 1,
      follows: trackNames.flatMap(([name, own]) =>
        value.trackType?.[own] === 1 ? [name] : [],
      ),
      targets: trackNames.flatMap(([name, own]) =>
        own in offered ? [name] : [],
      ),
      method:
        trackMethods.find(([, number]) => number === value.aiTrack)?.[0] ??
        null,
      methods: trackMethods.flatMap(([name, number]) =>
        range.aiTrack?.includes(number) === true ? [name] : [],
      ),
      backAfterLeaving: value.aiDisappearBackTime ?? null,
      backAfterStopping: value.aiStopBackTime ?? null,
      backChoices: range.aiDisappearBackTime ?? [],
    } satisfies Tracking;
  });

  /** A command's parameters, leaving out those not given. */
  const given = (
    entries: ReadonlyArray<
      readonly [string, string | number | Param | undefined]
    >,
  ): Param =>
    Object.fromEntries(
      entries.filter(
        (entry): entry is readonly [string, string | number | Param] =>
          entry[1] !== undefined,
      ),
    );

  const flag = (on: boolean | undefined) =>
    on === undefined ? undefined : Number(on);

  const ptz: SourcePtz = {
    state: Effect.fnUntraced(function* (camera) {
      const { channel, ptz: controls } = yield* steerable(camera);

      const zoom =
        channel.zoom === null
          ? null
          : yield* call([
              command("GetZoomFocus", { channel: channel.channel }),
            ]).pipe(
              Effect.flatMap((list) => valueOf(list, 0, ZoomFocus)),
              Effect.map(({ ZoomFocus: { zoom: now } }) => {
                const { min, max } = channel.zoom ?? { min: 0, max: 1 };

                return Math.min(1, Math.max(0, (now.pos - min) / (max - min)));
              }),
            );

      const presets = controls.presets
        ? yield* slotsOf(channel).pipe(
            Effect.map((slots) =>
              slots
                .filter((each) => each.enable === 1)
                .map((each) => ({
                  id: each.id,
                  name:
                    each.name === undefined || each.name === ""
                      ? `Preset ${each.id + 1}`
                      : each.name,
                })),
            ),
          )
        : [];

      const home = controls.home ? yield* homeOf(channel) : null;
      const tracking = controls.tracking ? yield* trackingOf(channel) : null;

      return { zoom, presets, home, tracking } satisfies PtzState;
    }),
    send: Effect.fnUntraced(function* (camera, order) {
      const { channel, ptz: controls } = yield* steerable(camera);

      /** The command, where the camera can do it. */
      const where = <A, E, R>(
        can: boolean,
        what: string,
        effect: Effect.Effect<A, E, R>,
      ) =>
        can
          ? effect
          : Effect.fail(new NotSupported({ message: `${camera} ${what}` }));

      const preset = (id: number, name: string) =>
        setting("SetPtzPreset", {
          PtzPreset: { channel: channel.channel, enable: 1, id, name },
        });

      const guard = (param: Param) =>
        where(
          controls.home,
          "has no home",
          setting("SetPtzGuard", {
            PtzGuard: { channel: channel.channel, ...param },
          }),
        );

      yield* PtzCommand.match(order, {
        Move: (move) => {
          const pan = controls.pan ? move.pan : 0;
          const tilt = controls.tilt ? move.tilt : 0;
          const size = Math.max(Math.abs(pan), Math.abs(tilt));

          const way = (value: number) =>
            Math.abs(value) < size * offAxis ? 0 : Math.sign(value);

          const op = moves.get(`${way(pan)},${way(tilt)}`);

          if (size === 0 || op === undefined) return stop(channel);

          return ptzCtrl(channel, { op }, Math.round(1 + 63 * size)).pipe(
            Effect.andThen(
              FiberMap.run(
                moving,
                channel.channel,
                Effect.sleep(stopAfter).pipe(
                  Effect.andThen(ptzCtrl(channel, { op: "Stop" })),
                  Effect.ignore,
                ),
              ),
            ),
          );
        },
        Stop: () => stop(channel),
        Zoom: ({ level }) => {
          if (channel.zoom === null) {
            return Effect.fail(
              new NotSupported({ message: `${camera} doesn't zoom` }),
            );
          }

          const { min, max } = channel.zoom;

          return call([
            command("StartZoomFocus", {
              ZoomFocus: {
                channel: channel.channel,
                op: "ZoomPos",
                pos: Math.round(min + level * (max - min)),
              },
            }),
          ]).pipe(
            Effect.flatMap((list) => valueOf(list, 0, Schema.Unknown)),
            Effect.asVoid,
          );
        },
        Preset: ({ id: preset }) =>
          where(
            controls.presets,
            "has no presets",
            ptzCtrl(channel, { op: "ToPos", id: preset }, 32),
          ),
        // Into the first slot not in use
        SavePreset: ({ name }) =>
          where(
            controls.presets,
            "has no presets",
            Effect.gen(function* () {
              const slots = yield* slotsOf(channel);
              const free = slots.find((slot) => slot.enable !== 1);

              if (free === undefined) {
                return yield* new NotSupported({
                  message: `${camera} has no preset slots left`,
                });
              }

              yield* preset(free.id, name);
            }),
          ),
        RenamePreset: ({ id: slot, name }) =>
          where(controls.presets, "has no presets", preset(slot, name)),
        ClearPreset: ({ id: slot }) =>
          where(
            controls.presets,
            "has no presets",
            setting("SetPtzPreset", {
              PtzPreset: { channel: channel.channel, enable: 0, id: slot },
            }),
          ),
        Home: () => guard({ cmdStr: "toPos" }),
        SetHome: () => guard({ cmdStr: "setPos", bSaveCurrentPos: 1 }),
        KeepHome: ({ on, backAfter }) =>
          guard(
            given([
              ["cmdStr", "setPos"],
              ["benable", flag(on)],
              ["timeout", backAfter],
            ]),
          ),
        Track: (change) =>
          where(
            controls.tracking,
            "doesn't follow what it sees",
            setting(
              "SetAiCfg",
              given([
                ["channel", channel.channel],
                ["bSmartTrack", flag(change.on)],
                [
                  "trackType",
                  change.follows === undefined
                    ? undefined
                    : Object.fromEntries(
                        trackNames.map(([name, own]) => [
                          own,
                          Number(change.follows?.includes(name)),
                        ]),
                      ),
                ],
                [
                  "aiTrack",
                  trackMethods.find(([name]) => name === change.method)?.[1],
                ],
                ["aiDisappearBackTime", change.backAfterLeaving],
                ["aiStopBackTime", change.backAfterStopping],
              ]),
            ),
          ),
      });
    }),
  };

  /** A camera with picture settings. */
  const adjustable = Effect.fnUntraced(function* (camera: CameraId) {
    const device = yield* opened;
    const channel = yield* channelOf(device, camera);

    if (channel.picture === null) {
      return yield* new NotSupported({
        message: `${camera} has no picture settings`,
      });
    }

    return { channel, controls: channel.picture };
  });

  /** Its picture settings now, each as a share of its range. */
  const imageNow = (channel: Channel) =>
    call([command("GetImage", { channel: channel.channel })]).pipe(
      Effect.flatMap((list) => valueOf(list, 0, Image)),
      Effect.map(({ Image: now }) => {
        const shareOf = (setting: PictureName) => {
          const known = channel.image.get(setting);
          const value = known === undefined ? undefined : now[known.own];

          return known === undefined || value === undefined
            ? null
            : Math.min(
                1,
                Math.max(0, (value - known.min) / (known.max - known.min)),
              );
        };

        return {
          hue: shareOf("hue"),
          brightness: shareOf("brightness"),
          contrast: shareOf("contrast"),
          saturation: shareOf("saturation"),
          sharpness: shareOf("sharpness"),
        } satisfies PictureState;
      }),
    );

  const picture: SourcePicture = {
    state: Effect.fnUntraced(function* (camera) {
      const { channel } = yield* adjustable(camera);

      return yield* imageNow(channel);
    }),
    send: Effect.fnUntraced(function* (camera, order) {
      const { channel, controls } = yield* adjustable(camera);

      const values = yield* PictureCommand.match(order, {
        Set: (change) => {
          const asked = pictureNames.flatMap(([setting]) => {
            const share = change[setting];

            return share === undefined ? [] : [[setting, share] as const];
          });

          const missing = asked.find(
            ([setting]) => !channel.image.has(setting),
          );

          if (missing !== undefined) {
            return Effect.fail(
              new NotSupported({ message: `${camera} has no ${missing[0]}` }),
            );
          }

          return Effect.succeed(
            asked.flatMap(([setting, share]) => {
              const known = channel.image.get(setting);

              return known === undefined
                ? []
                : [
                    [
                      known.own,
                      Math.round(known.min + share * (known.max - known.min)),
                    ] as const,
                  ];
            }),
          );
        },
        Reset: () =>
          controls.reset
            ? Effect.succeed(
                [...channel.image.values()].flatMap((known) =>
                  known.initial === undefined
                    ? []
                    : [[known.own, known.initial] as const],
                ),
              )
            : Effect.fail(
                new NotSupported({
                  message: `${camera} can't go back to its defaults`,
                }),
              ),
      });

      if (values.length > 0) {
        yield* setting("SetImage", {
          Image: { channel: channel.channel, ...Object.fromEntries(values) },
        });
      }

      return yield* imageNow(channel);
    }),
  };

  /** This machine's address as the camera reaches it. */
  const ownAddress = addressToward(base.hostname).pipe(
    Effect.mapError(() => unavailable("can't be reached from this machine")),
  );

  /** What the camera is given to find this machine: its DNS name where the network has one, or else its address. */
  const ownHost = ownAddress.pipe(
    Effect.flatMap((address) =>
      nameOf(address).pipe(
        Effect.map((named) => ({ address, host: named ?? address })),
      ),
    ),
  );

  /** Sends one setting, failing with why it was refused. */
  const set = (cmd: string, param: Param) =>
    call([command(cmd, param)]).pipe(
      Effect.flatMap((list) => valueOf(list, 0, Schema.Unknown)),
    );

  const uploads: SourceUploads = {
    sending: Effect.fnUntraced(function* (target) {
      const saved = yield* call([command("GetFtp", { channel: 0 })]).pipe(
        Effect.flatMap((list) => valueOf(list, 0, Ftp)),
      );

      const own = yield* ownHost;

      return sendsTo(saved, {
        hosts: [own.host, own.address],
        port: target.port,
        user: target.user,
      });
    }),
    send: Effect.fnUntraced(function* (target) {
      if (target === null) {
        yield* set("SetFtp", stopped);

        return {
          on: false,
          tested: null,
          message: `${name} has stopped sending clips`,
        };
      }

      const { host } = yield* ownHost;

      const param = pointedAt({
        host,
        port: target.port,
        user: target.user,
        password: Redacted.value(target.password),
      });

      yield* set("SetFtp", param);

      // Older firmware answers TestFtp without trying, so it's only asked where it says it can
      const testable = yield* call([
        command("GetAbility", { User: { userName: Redacted.value(username) } }),
      ]).pipe(
        Effect.flatMap((list) => valueOf(list, 0, DeviceAbility)),
        Effect.map((value) => (value.Ability.ftpTest?.ver ?? 0) > 0),
        Effect.orElseSucceed(() => false),
      );

      if (!testable) {
        return {
          on: true,
          tested: null,
          message: `${name} sends its clips to Kestrel at ${host} now. It has no test of its own, so its first clip shows it works.`,
        };
      }

      const test = (yield* call([command("TestFtp", param)]))[0];

      return test?.code === 0
        ? {
            on: true,
            tested: true,
            message: `${name} reached Kestrel at ${host}`,
          }
        : {
            on: true,
            tested: false,
            message: `${name} couldn't reach Kestrel at ${host}${test?.error?.detail === undefined ? "" : `: ${test.error.detail}`}`,
          };
    }),
    clip: (path) =>
      opened.pipe(
        Effect.map((device) => {
          const begin = clipStart(path);
          const channel = device.channels[0];

          return begin === null || channel === undefined
            ? null
            : { camera: cameraOf(channel), begin };
        }),
      ),
  };

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
        device.channels.map((channel): CameraInfo => {
          const info: CameraInfo = {
            id: cameraOf(channel),
            name: channel.name,
            channel: device.recorder ? channel.channel + 1 : null,
            signal: channel.online,
            live: true,
            still: true,
            recordings: true,
            events: true,
          };

          const withPtz =
            channel.ptz === null ? info : { ...info, ptz: channel.ptz };

          return channel.picture === null
            ? withPtz
            : { ...withPtz, picture: channel.picture };
        }),
      ),
    ),
    get recordings(): SourceRecordings {
      return replaying ? { ...listing, video } : listing;
    },
    // A hub or recorder hands its files over itself
    get uploads(): SourceUploads | undefined {
      return replaying ? undefined : uploads;
    },
    live: opened.pipe(
      Effect.map((device) =>
        device.channels.map((channel): LiveFeed => {
          const feed = {
            camera: cameraOf(channel),
            main: channel.main,
            sub: channel.sub,
            sound: true,
          };

          // Its lens zoom only changes the telephoto picture
          return channel.telephoto === null
            ? feed
            : {
                ...feed,
                view: { name: "Wide", zoom: false },
                others: [
                  {
                    key: "telephoto",
                    name: "Telephoto",
                    main: channel.telephoto,
                    sub: null,
                    zoom: channel.zoom !== null,
                  },
                ],
              };
        }),
      ),
    ),
    ptz,
    picture,
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
