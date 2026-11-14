/**
 * Live streams from web pages as a source, such as a Twitch channel, a
 * YouTube live stream or a webcam site's page. A web page's stream address
 * carries a token that soon runs out, so go2rtc runs yt-dlp
 * (`KESTREL_YT_DLP`, or the one on the path) through its `echo:` source
 * each time a stream starts, for the address that works then, which
 * go2rtc's ffmpeg copies, with Node.js (`KESTREL_NODE`, or the one on the
 * path) for the sites yt-dlp reads with JavaScript. The source
 * builds that command itself from each page's address, which must be an
 * http or https one; yt-dlp is told to ignore its config files, so nothing
 * else on the server changes what it runs. Live view only: no recordings,
 * events or stills.
 *
 * @module
 */
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import {
  CameraKey,
  cameraId,
  InvalidSettings,
  type Attention,
  type CameraInfo,
  type Kind,
  type LiveFeed,
  type Source,
  type SourceSettings,
} from "@timmo001/kestrel-core";
import {
  Config,
  DateTime,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** How long yt-dlp has to say its version when the source starts. */
const checkTimeout = Duration.seconds(30);

/**
 * The formats yt-dlp picks: the best with sound where the site offers one,
 * as Twitch does, or else the best picture alone, as YouTube's live streams
 * keep their sound apart; and for the sub stream, the same at 480 lines or
 * fewer, else the smallest picture.
 */
const formats = {
  main: "b/bv",
  sub: "b[height<=480]/bv[height<=480]/wv",
} as const;

/** A page's address, such as `https://www.twitch.tv/<channel>`: http or https only. */
const Page = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return "isn't an address";

    const { protocol } = new URL(value);

    return (
      protocol === "https:" ||
      protocol === "http:" ||
      "must be a web page's address, starting https://"
    );
  }),
);

/** A camera's settings. */
const CameraSettings = Schema.Struct({
  id: CameraKey,
  name: Schema.String,
  page: Page,
});

interface CameraSettings extends Schema.Schema.Type<typeof CameraSettings> {}

const decodeCamera = Schema.decodeUnknownEffect(CameraSettings);

/** What the app shows when you add or change a source of web pages. */
export const info: Kind["info"] = {
  kind: "web",
  name: "Web pages",
  description:
    "Live streams from web pages, such as a Twitch channel or a YouTube live stream, through yt-dlp: live view only. Keep to each site's terms; Twitch's ads play in the stream",
  fields: [],
  cameraFields: [
    {
      key: "id",
      label: "Id",
      type: "text",
      required: true,
      hint: "Lower-case letters, digits and dashes, such as harbour; it names the camera in links",
    },
    {
      key: "name",
      label: "Name",
      type: "text",
      required: true,
      hint: null,
    },
    {
      key: "page",
      label: "Page",
      type: "address",
      required: true,
      hint: "The live stream's page, such as https://www.twitch.tv/<channel> or a YouTube live link; any page yt-dlp reads",
    },
  ],
};

/** A program's path as go2rtc reads it, quoted where it has spaces, such as under `C:\Program Files`. */
const quoted = (program: string) =>
  /\s/.test(program) ? `"${program}"` : program;

/**
 * The go2rtc address that runs yt-dlp for a page's stream in one format.
 * go2rtc splits it on spaces and runs it without a shell; a parsed address
 * has no spaces or quotes at its start, and comes after `--` so yt-dlp never
 * reads it as an option. Its fragment is left off, since go2rtc reads `#`
 * as its own. yt-dlp answers with the stream for go2rtc's ffmpeg to copy,
 * since go2rtc's own reader drops YouTube's streams every few seconds. The
 * sound is made again as AAC: a site's HLS, such as Twitch's, carries AAC
 * that ffmpeg can't copy into go2rtc's RTSP, and the whole stream fails.
 */
export const echoAddress = (
  ytDlp: string,
  node: string | null,
  page: string,
  format: string,
) => {
  const url = new URL(page);

  url.hash = "";

  return [
    `echo:${quoted(ytDlp)}`,
    "--ignore-config",
    "--quiet",
    "--no-warnings",
    // Deno is the one yt-dlp looks for by itself; YouTube's live streams play
    // without one today, but Node is there should they come to need one
    "--js-runtimes",
    quoted(node === null ? "node" : `node:${node}`),
    "--format",
    format,
    "--print",
    "ffmpeg:%(url)s#video=copy#audio=aac",
    "--",
    url.href,
  ].join(" ");
};

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

/** A source of web pages, for as long as the scope lasts. */
export const make = Effect.fnUntraced(function* (saved: SourceSettings) {
  const id = saved.id;
  const name = saved.name;

  const invalid = (message: string) =>
    new InvalidSettings({ message: `${name}: ${message}` });

  const cameras = yield* Effect.forEach(saved.cameras, (values, at) =>
    decodeCamera(
      Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== ""),
      ),
    ).pipe(
      Effect.mapError((error) => invalid(`camera ${at + 1}: ${error.message}`)),
    ),
  );

  const ytDlp = yield* Config.String("KESTREL_YT_DLP").pipe(
    Effect.orElseSucceed(() => "yt-dlp"),
  );

  const node = yield* Config.String("KESTREL_NODE").pipe(
    Effect.orElseSucceed(() => null),
  );

  const context = yield* Layer.build(services);

  // yt-dlp runs only as streams start, so it's tried once here to say up
  // front when it's missing
  const missing = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make(ytDlp, ["--version"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.flatMap((handle) => handle.exitCode)),
    );
  }).pipe(
    Effect.provideContext(context),
    Effect.map((code) =>
      code === 0 ? null : `yt-dlp exited with code ${code}`,
    ),
    Effect.timeoutOrElse({
      duration: checkTimeout,
      orElse: () => Effect.succeed("yt-dlp didn't answer in time"),
    }),
    Effect.orElseSucceed(
      () =>
        "yt-dlp isn't installed; put it on the path or set KESTREL_YT_DLP to it",
    ),
  );

  const since = DateTime.formatIso(yield* DateTime.now);

  const attention: ReadonlyArray<Attention> =
    missing === null
      ? []
      : [
          {
            source: id,
            level: "alert",
            kind: "connection",
            message: `${name} can't play its streams: ${missing}`,
          },
        ];

  const source: Source = {
    id,
    kind: "web",
    name,
    connection: Effect.succeed({
      connected: missing === null,
      since: missing === null ? since : null,
      error: missing,
    }),
    attention: Effect.succeed(attention),
    cameras: Effect.succeed(
      cameras.map((camera): CameraInfo => ({
        id: cameraId(id, camera.id),
        name: camera.name,
        channel: null,
        signal: null,
        live: true,
        still: false,
        recordings: false,
        events: false,
      })),
    ),
    live: Effect.succeed(
      cameras.map((camera: CameraSettings): LiveFeed => ({
        camera: cameraId(id, camera.id),
        main: Redacted.make(
          echoAddress(ytDlp, node, camera.page, formats.main),
        ),
        sub: Redacted.make(echoAddress(ytDlp, node, camera.page, formats.sub)),
        sound: true,
      })),
    ),
  };

  return source;
});
