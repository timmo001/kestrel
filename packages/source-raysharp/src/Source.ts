/**
 * A Raysharp recorder as a source: one logged-in session, opened when the
 * server starts and reopened with backoff whenever it drops, with the alarm
 * reports it sends kept and passed on. Each channel is a camera, such as
 * `swann/3`, with its RTSP streams for live view, its recordings and its
 * picture's colour. Its
 * address and login come from its settings, and any it leaves out from the
 * environment: `KESTREL_RAYSHARP_HOST`, `_USERNAME` and `_PASSWORD`, with
 * `_PORT` and `_RTSP_PORT` when they aren't the defaults, and
 * `_RTSP_USERNAME` or `_RTSP_PASSWORD` for a separate RTSP login.
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
  SourceUnavailable,
  UnknownCamera,
  type CameraEvent,
  type CameraId,
  type CameraInfo,
  type Connection,
  type Details,
  type Kind,
  type LiveFeed,
  type PictureControls,
  type PictureState,
  type RecordedFrame,
  type Recording,
  type Source,
  type SourceId,
  type SourceSettings,
} from "@timmo001/kestrel-core";
import {
  Session,
  type AlarmEvent,
  type ChannelColour,
  type ColourChange,
  type RecorderStatus,
} from "@timmo001/kestrel-protocol-raysharp";
import {
  Config,
  DateTime,
  Duration,
  Effect,
  Option,
  Predicate,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { attentionFor } from "./Attention.ts";
import { fromSeconds, stretches, toSeconds } from "./Stretches.ts";

/** How often the recorder's status is read, for what needs you. */
const pollEvery = Duration.minutes(1);

/** How many alarm reports the source keeps for a page that opens later. */
const keptEvents = 200;

/** How many times, a second apart, to wait for the recorder to finish another playback. */
const busyTries = 15;

/**
 * Opens a recorded stream again while the recorder is busy with another
 * playback or download; it lets go of the last a few seconds after it
 * closes, such as when the player changes speed. Busy only comes before the
 * first frame, so opening again repeats nothing.
 */
const whenFree = (
  open: () => Stream.Stream<RecordedFrame, Session.SessionError>,
  tries = busyTries,
): Stream.Stream<RecordedFrame, Session.SessionError> =>
  open().pipe(
    Stream.catchTag("RecorderBusy", (busy) =>
      tries <= 1
        ? Stream.fail(busy)
        : Stream.unwrap(
            Effect.sleep(Duration.seconds(1)).pipe(
              Effect.as(whenFree(open, tries - 1)),
            ),
          ),
    ),
  );

const retry = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

const twoDigits = (channel: number) => String(channel).padStart(2, "0");

/** The last day of a month such as `2026-11`, as two digits. */
const lastDay = (month: string) => {
  const [year = 1970, number = 1] = month.split("-").map(Number);

  return String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(
    2,
    "0",
  );
};

/** The recorder's channels, from 1. */
const channelsOf = (opened: Session.Session) =>
  Array.from({ length: opened.device.channels }, (_, index) => index + 1);

/** The recorder's device and status as general details. */
const detailsOf = (
  id: SourceId,
  opened: Session.Session,
  status: RecorderStatus,
): Details => ({
  clock: status.time,
  facts: [
    { label: "Name", value: opened.device.name },
    { label: "Firmware", value: opened.device.firmware },
    { label: "Channels", value: String(opened.device.channels) },
  ],
  storage: status.disks.map((disk) => ({
    name: `Disk ${disk.disk}`,
    state: disk.state,
    ok: disk.state === "ok",
  })),
  cameras: status.channels.map((channel) => ({
    camera: cameraId(id, String(channel.channel)),
    signal: !channel.videoLoss,
    recording: channel.recordingMode,
    motion: channel.motion,
  })),
});

/** A channel's colour as shares of its range; sharpness always runs to 255. */
const pictureOf = (colour: ChannelColour): PictureState => ({
  hue: colour.hue / colour.range,
  brightness: colour.brightness / colour.range,
  contrast: colour.contrast / colour.range,
  saturation: colour.saturation / colour.range,
  sharpness: colour.sharpness / 255,
});

/** What a channel with a colour page lets you change. */
const pictureControls = (colour: ChannelColour): PictureControls => ({
  hue: true,
  brightness: true,
  contrast: true,
  saturation: true,
  sharpness: true,
  reset: colour.resettable,
});

/** The settings a recorder takes, each left out falling back to its environment variable. */
const RecorderSettings = Schema.Struct({
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  rtspPort: Schema.optional(Schema.Number),
  rtspUsername: Schema.optional(Schema.String),
  rtspPassword: Schema.optional(Schema.String),
});

const decodeSettings = Schema.decodeUnknownEffect(RecorderSettings);

/** Where a recorder's settings come from when its own leave them out. */
const prefix = "KESTREL_RAYSHARP_";

/** A recorder's environment variable, such as `KESTREL_RAYSHARP_HOST`. */
const env = <A>(read: (name: string) => Config.Config<A>, name: string) =>
  read(`${prefix}${name}`);

/** What the app shows when you add or change a recorder. */
export const info: Kind["info"] = {
  kind: "raysharp",
  name: "Raysharp recorder",
  description:
    "A recorder made by Raysharp, such as a Swann DVR: live view, recordings, events and its disks",
  fields: [
    {
      key: "host",
      label: "Address",
      type: "text",
      required: false,
      hint: "Its address on your network; KESTREL_RAYSHARP_HOST when left out",
    },
    {
      key: "port",
      label: "Control port",
      type: "number",
      required: false,
      hint: "9000 when left out",
    },
    {
      key: "username",
      label: "Username",
      type: "text",
      required: false,
      hint: "KESTREL_RAYSHARP_USERNAME when left out",
    },
    {
      key: "password",
      label: "Password",
      type: "secret",
      required: false,
      hint: "KESTREL_RAYSHARP_PASSWORD when left out",
    },
    {
      key: "rtspPort",
      label: "RTSP port",
      type: "number",
      required: false,
      hint: "554 when left out",
    },
    {
      key: "rtspUsername",
      label: "RTSP username",
      type: "text",
      required: false,
      hint: "Only where its live streams take a different login",
    },
    {
      key: "rtspPassword",
      label: "RTSP password",
      type: "secret",
      required: false,
      hint: "Only where its live streams take a different login",
    },
  ],
  cameraFields: null,
};

/** A recorder as a source, logged in for as long as the scope lasts. */
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
  ).pipe(Effect.mapError((error) => invalid(error.message)));

  /** A setting, or its environment variable when it's left out. */
  const orEnv = <A>(value: A | undefined, config: Config.Config<A>) =>
    value === undefined
      ? Effect.gen(function* () {
          return yield* config;
        })
      : Effect.succeed(value);

  const host = yield* orEnv(settings.host, env(Config.String, "HOST")).pipe(
    Effect.mapError(() => invalid("it needs an address")),
  );

  const port = yield* orEnv(
    settings.port,
    env(Config.Int, "PORT").pipe(Config.withDefault(9000)),
  ).pipe(Effect.mapError(() => invalid(`${prefix}PORT isn't a port`)));

  const login = Effect.mapError(() =>
    invalid("it needs a username and password"),
  );

  const secret = (value: string | undefined) =>
    value === undefined ? undefined : Redacted.make(value);

  const username = yield* orEnv(
    secret(settings.username),
    env(Config.Redacted, "USERNAME"),
  ).pipe(login);

  const password = yield* orEnv(
    secret(settings.password),
    env(Config.Redacted, "PASSWORD"),
  ).pipe(login);

  const rtspPort = yield* orEnv(
    settings.rtspPort,
    env(Config.Int, "RTSP_PORT").pipe(Config.withDefault(554)),
  ).pipe(Effect.mapError(() => invalid(`${prefix}RTSP_PORT isn't a port`)));

  // Some recorders keep a separate RTSP login; otherwise it's the same one
  const rtspUsername = yield* orEnv(
    secret(settings.rtspUsername),
    env(Config.Redacted, "RTSP_USERNAME").pipe(
      Config.orElse(() => Config.succeed(username)),
    ),
  ).pipe(login);

  const rtspPassword = yield* orEnv(
    secret(settings.rtspPassword),
    env(Config.Redacted, "RTSP_PASSWORD").pipe(
      Config.orElse(() => Config.succeed(password)),
    ),
  ).pipe(login);

  const rtsp = (channel: number, stream: 0 | 1) =>
    Redacted.make(
      `rtsp://${encodeURIComponent(Redacted.value(rtspUsername))}:${encodeURIComponent(Redacted.value(rtspPassword))}@${host}:${rtspPort}/ch${twoDigits(channel)}/${stream}`,
    );

  const current = yield* Ref.make(Option.none<Session.Session>());

  const connection = yield* Ref.make<Connection>({
    connected: false,
    since: null,
    error: null,
  });

  const recent = yield* Ref.make<ReadonlyArray<CameraEvent>>([]);
  const events = yield* PubSub.sliding<CameraEvent>(256);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const receive = Effect.fnUntraced(function* (event: AlarmEvent) {
    const received: CameraEvent = {
      source: id,
      camera:
        event.channel === null ? null : cameraId(id, String(event.channel)),
      kind: event.kind,
      active: event.active,
      time: event.time,
      receivedAt: yield* now,
    };

    yield* Ref.update(recent, (list) =>
      [received, ...list].slice(0, keptEvents),
    );

    yield* PubSub.publish(events, received);
  });

  const session = Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* Session.connect({
        host,
        port,
        username,
        password,
        alarms: true,
      });

      yield* Ref.set(current, Option.some(opened));

      yield* Ref.set(connection, {
        connected: true,
        since: yield* now,
        error: null,
      });

      yield* Effect.logInfo(
        `Logged in to ${opened.device.name} (${opened.device.firmware})`,
      );

      yield* opened.alarms.pipe(Stream.runForEach(receive), Effect.forkScoped);

      return yield* opened.closed;
    }),
  ).pipe(
    Effect.ensuring(Ref.set(current, Option.none())),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const message = error.message;

        yield* Ref.set(connection, {
          connected: false,
          since: yield* now,
          error: message,
        });

        yield* Effect.logWarning(`Recorder session ended: ${message}`);
      }),
    ),
  );

  yield* session.pipe(Effect.retry(retry), Effect.forkScoped);

  const unavailable = (error: Session.SessionError) =>
    new SourceUnavailable({ message: error.message });

  /** The open session, or why there isn't one. */
  const opened = Ref.get(current).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new SourceUnavailable({
              message: "Not logged in to the recorder yet",
            }),
          ),
        onSome: (open) => Effect.succeed(open),
      }),
    ),
  );

  /** The channel a camera's id names, such as 3 for `swann/3`, if it's this recorder's. */
  const channelOf = (open: Session.Session, camera: CameraId) => {
    const parts = cameraParts(camera);
    const channel = Number(parts.camera);

    return parts.source === id &&
      /^[1-9]\d*$/.test(parts.camera) &&
      channel <= open.device.channels
      ? Effect.succeed(channel)
      : Effect.fail(
          new UnknownCamera({
            message: `${name} has no camera ${camera}`,
          }),
        );
  };

  /** A recorder that turns its colour page down has no picture settings. */
  const fromColour =
    (camera: CameraId) =>
    (error: Session.SessionError): NotSupported | SourceUnavailable =>
      Predicate.isTagged(error, "RequestRefused")
        ? new NotSupported({
            message: `${camera} has no picture settings: ${error.reason}`,
          })
        : unavailable(error);

  // Each channel's colour page as first read, for its range and whether it
  // can go back to its defaults, which don't change. Kept once a read works
  const firstColours = yield* Ref.make(
    Option.none<ReadonlyArray<ChannelColour>>(),
  );

  const coloursOf = (open: Session.Session) =>
    Ref.get(firstColours).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            open
              .colours(channelsOf(open))
              .pipe(
                Effect.tap((found) =>
                  Ref.set(firstColours, Option.some(found)),
                ),
              ),
        }),
      ),
    );

  /** A camera's channel and its colour page as first read. */
  const colourOf = Effect.fnUntraced(function* (camera: CameraId) {
    const open = yield* opened;
    const channel = yield* channelOf(open, camera);

    const page = (yield* coloursOf(open).pipe(
      Effect.mapError(fromColour(camera)),
    )).find((each) => each.channel === channel);

    if (page === undefined) {
      return yield* new NotSupported({
        message: `${camera} has no picture settings`,
      });
    }

    return { open, channel, page };
  });

  // The latest status, read every minute for what needs you, and the
  // channels that have had a signal since the server started
  const latest = yield* Ref.make<RecorderStatus | null>(null);
  const hadSignal = new Set<number>();

  // Retried within the minute, so the first read doesn't miss the login
  // that's still under way as the server starts
  const readStatus = opened.pipe(
    Effect.flatMap((open) => open.status),
    Effect.retry(
      Schedule.spaced(Duration.seconds(5)).pipe(
        Schedule.upTo({ duration: Duration.seconds(55) }),
      ),
    ),
    Effect.tap((status) =>
      Effect.sync(() => {
        for (const channel of status.channels) {
          if (!channel.videoLoss) hadSignal.add(channel.channel);
        }
      }),
    ),
    Effect.flatMap((status) => Ref.set(latest, status)),
    Effect.catch(() => Ref.set(latest, null)),
  );

  yield* readStatus.pipe(
    Effect.repeat(Schedule.spaced(pollEvery)),
    Effect.forkScoped,
  );

  const source: Source = {
    id,
    kind: "raysharp",
    name,
    connection: Ref.get(connection),
    attention: Effect.gen(function* () {
      return attentionFor(
        { id, name },
        yield* Ref.get(connection),
        yield* Ref.get(latest),
        hadSignal,
      );
    }),
    cameras: Effect.gen(function* () {
      const open = yield* opened;
      const status = yield* open.status.pipe(Effect.option);

      const colours = yield* coloursOf(open).pipe(
        Effect.orElseSucceed((): ReadonlyArray<ChannelColour> => []),
      );

      return channelsOf(open).map((channel): CameraInfo => {
        const state = Option.getOrUndefined(status)?.channels.find(
          (each) => each.channel === channel,
        );

        const colour = colours.find((each) => each.channel === channel);

        const info: CameraInfo = {
          id: cameraId(id, String(channel)),
          name: `Channel ${channel}`,
          channel,
          signal: state === undefined ? null : !state.videoLoss,
          live: true,
          still: false,
          recordings: true,
          events: true,
        };

        if (colour === undefined) return info;

        return { ...info, picture: pictureControls(colour) };
      });
    }),
    // The channel count comes from the login
    live: opened.pipe(
      Effect.map((open) =>
        channelsOf(open).map((channel): LiveFeed => ({
          camera: cameraId(id, String(channel)),
          main: rtsp(channel, 0),
          sub: rtsp(channel, 1),
          // The sub stream squeezes the 16:9 picture into 352×288
          subRatio: 16 / 9,
        })),
      ),
    ),
    recordings: {
      days: (month) =>
        opened.pipe(
          Effect.flatMap((open) =>
            open
              .recordedDays({
                channels: channelsOf(open),
                begin: `${month}-01T00:00:00`,
                end: `${month}-${lastDay(month)}T23:59:59`,
              })
              .pipe(Effect.mapError(unavailable)),
          ),
        ),
      list: Effect.fnUntraced(function* (camera, date) {
        const open = yield* opened;
        const channel = yield* channelOf(open, camera);

        const found = yield* open
          .recordings({
            channel,
            begin: `${date}T00:00:00`,
            end: `${date}T23:59:59`,
          })
          .pipe(Effect.mapError(unavailable));

        return found.map((recording): Recording => ({
          camera,
          begin: recording.begin,
          end: recording.end,
          reasons: recording.reasons,
          bytes: recording.bytes,
        }));
      }),
      video: Effect.fnUntraced(function* (request) {
        const open = yield* opened;
        const channel = yield* channelOf(open, request.camera);

        const found = yield* open
          .recordings({
            channel,
            // From an hour before, for a file that starts earlier and runs
            // into the range, to a minute after, for whether the next file
            // follows straight on
            begin: fromSeconds(toSeconds(request.begin) - 3600),
            end: fromSeconds(toSeconds(request.end) + 60),
          })
          .pipe(Effect.mapError(unavailable));

        const parts = stretches(found, request.begin, request.end);

        if (parts.length === 0) {
          return yield* new NoRecordings({
            message: `Nothing was recorded on ${request.camera} from ${request.begin} to ${request.end}`,
          });
        }

        const every = request.every;

        // A file at a time, whole or key frames only
        return Stream.fromIterable(parts).pipe(
          Stream.flatMap((part) =>
            whenFree(() =>
              every === undefined
                ? open.download({
                    channel,
                    stream: request.stream,
                    begin: part.begin,
                    end: part.end,
                  })
                : open.keyFrames({
                    channel,
                    stream: request.stream,
                    begin: part.begin,
                    end: part.end,
                    every,
                  }),
            ),
          ),
          Stream.mapError(unavailable),
        );
      }),
    },
    events: {
      recent: Ref.get(recent),
      live: Stream.fromPubSub(events),
    },
    picture: {
      state: Effect.fnUntraced(function* (camera) {
        const { open, channel } = yield* colourOf(camera);

        const now = (yield* open
          .colours([channel])
          .pipe(Effect.mapError(fromColour(camera)))).find(
          (each) => each.channel === channel,
        );

        if (now === undefined) {
          return yield* new NotSupported({
            message: `${camera} has no picture settings`,
          });
        }

        return pictureOf(now);
      }),
      send: Effect.fnUntraced(function* (camera, command) {
        const { open, channel, page } = yield* colourOf(camera);

        const scaled = (share: number | undefined, top: number) =>
          share === undefined ? undefined : share * top;

        const change = yield* PictureCommand.match(command, {
          Set: (set): Effect.Effect<ColourChange | "defaults", NotSupported> =>
            Effect.succeed({
              hue: scaled(set.hue, page.range),
              brightness: scaled(set.brightness, page.range),
              contrast: scaled(set.contrast, page.range),
              saturation: scaled(set.saturation, page.range),
              sharpness: scaled(set.sharpness, 255),
            }),
          Reset: () =>
            page.resettable
              ? Effect.succeed("defaults" as const)
              : Effect.fail(
                  new NotSupported({
                    message: `${camera} can't go back to its defaults`,
                  }),
                ),
        });

        const saved = yield* open
          .saveColour(channel, change)
          .pipe(Effect.mapError(fromColour(camera)));

        return pictureOf(saved);
      }),
    },
    details: Effect.gen(function* () {
      const open = yield* opened;
      const status = yield* open.status.pipe(Effect.mapError(unavailable));

      return detailsOf(id, open, status);
    }),
  };

  return source;
});
