/**
 * Cameras you list by their stream addresses as a source, such as an IP
 * camera's RTSP stream. Each has an id of its own, such as `porch` for
 * `garden/porch`, a name, and a main stream, a sub stream and a still
 * picture address, each optional but one of the main stream and the still.
 * go2rtc plays the streams, so the source has nothing to log in to: it
 * counts as connected, and can't tell whether a camera has a picture.
 *
 * @module
 */
import {
  CameraKey,
  cameraId,
  InvalidSettings,
  SourceUnavailable,
  UnknownCamera,
  type CameraId,
  type CameraInfo,
  type Kind,
  type LiveFeed,
  type Source,
  type SourceSettings,
  type StillPicture,
} from "@timmo001/kestrel-core";
import { DateTime, Duration, Effect, Redacted, Schema } from "effect";

/** How long a still picture has to arrive. */
const stillTimeout = Duration.seconds(10);

/** An address that parses as a URL, such as `rtsp://192.0.2.20:554/stream1`. */
const Address = Schema.String.check(
  Schema.makeFilter((value) => URL.canParse(value) || "isn't an address"),
);

/** A camera's settings, each address left empty counting as left out. */
const CameraSettings = Schema.Struct({
  id: CameraKey,
  name: Schema.String,
  main: Schema.optional(Address),
  sub: Schema.optional(Address),
  still: Schema.optional(Address),
});

interface CameraSettings extends Schema.Schema.Type<typeof CameraSettings> {}

const decodeCamera = Schema.decodeUnknownEffect(CameraSettings);

/** What the app shows when you add or change a source of streams. */
export const info: Kind["info"] = {
  kind: "stream",
  name: "Streams",
  description:
    "Cameras by their stream addresses, such as RTSP, RTMP, HLS or MJPEG, or a still picture: live view only",
  fields: [],
  cameraFields: [
    {
      key: "id",
      label: "Id",
      type: "text",
      required: true,
      hint: "Lower-case letters, digits and dashes, such as porch; it names the camera in links",
    },
    {
      key: "name",
      label: "Name",
      type: "text",
      required: true,
      hint: null,
    },
    {
      key: "main",
      label: "Stream",
      type: "address",
      required: false,
      hint: "Such as rtsp://user:password@192.0.2.20:554/stream1; any address go2rtc plays",
    },
    {
      key: "sub",
      label: "Sub stream",
      type: "address",
      required: false,
      hint: "A smaller stream, for when many cameras show at once",
    },
    {
      key: "still",
      label: "Still picture",
      type: "address",
      required: false,
      hint: "A JPEG address, shown in place of video for a camera with no stream",
    },
  ],
};

/** A request for an address, with any login in it sent as basic auth, since fetch won't take one in the address. */
const requestFor = (address: string) => {
  const url = new URL(address);
  const headers = new Headers();

  if (url.username !== "" || url.password !== "") {
    const login = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;

    headers.set(
      "authorization",
      `Basic ${Buffer.from(login).toString("base64")}`,
    );

    url.username = "";
    url.password = "";
  }

  return { url: url.href, headers };
};

/** A source of streams, for as long as the scope lasts. */
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
      Effect.flatMap((camera) =>
        camera.main === undefined && camera.still === undefined
          ? Effect.fail(
              invalid(`${camera.name} needs a stream or a still picture`),
            )
          : Effect.succeed(camera),
      ),
    ),
  );

  const since = DateTime.formatIso(yield* DateTime.now);

  const find = (camera: CameraId) => {
    const found = cameras.find((each) => cameraId(id, each.id) === camera);

    return found === undefined
      ? Effect.fail(
          new UnknownCamera({ message: `${name} has no camera ${camera}` }),
        )
      : Effect.succeed(found);
  };

  const fetchStill = (camera: CameraSettings, address: string) =>
    Effect.tryPromise({
      try: async (signal): Promise<StillPicture> => {
        const request = requestFor(address);

        const response = await fetch(request.url, {
          headers: request.headers,
          signal,
        });

        if (!response.ok) throw new Error(`it answered ${response.status}`);

        return {
          data: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") ?? "image/jpeg",
        };
      },
      // The address can hold a login, so it's left out of the message
      catch: (error) =>
        new SourceUnavailable({
          message: `${camera.name}'s still picture couldn't be read${error instanceof Error ? `: ${error.message}` : ""}`,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: stillTimeout,
        orElse: () =>
          Effect.fail(
            new SourceUnavailable({
              message: `${camera.name}'s still picture didn't arrive in time`,
            }),
          ),
      }),
    );

  const source: Source = {
    id,
    kind: "stream",
    name,
    connection: Effect.succeed({ connected: true, since, error: null }),
    attention: Effect.succeed([]),
    cameras: Effect.succeed(
      cameras.map((camera): CameraInfo => ({
        id: cameraId(id, camera.id),
        name: camera.name,
        channel: null,
        signal: null,
        live: camera.main !== undefined,
        still: camera.still !== undefined,
        recordings: false,
        events: false,
      })),
    ),
    live: Effect.succeed(
      cameras.flatMap((camera): Array<LiveFeed> =>
        camera.main === undefined
          ? []
          : [
              {
                camera: cameraId(id, camera.id),
                main: Redacted.make(camera.main),
                sub:
                  camera.sub === undefined ? null : Redacted.make(camera.sub),
              },
            ],
      ),
    ),
    stills: {
      still: Effect.fnUntraced(function* (camera) {
        const found = yield* find(camera);

        if (found.still === undefined) {
          return yield* new UnknownCamera({
            message: `${found.name} has no still picture`,
          });
        }

        return yield* fetchStill(found, found.still);
      }),
    },
  };

  return source;
});
