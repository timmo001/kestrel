/**
 * Old addresses and saved settings, carried over: the pages used to be hash
 * addresses, such as `/#recordings`, and before camera ids Recordings and
 * Live named the recorder's channels by number. Plain functions with no page
 * in them, so they can be tested.
 */
import { CameraId, cameraId, cameraParts } from "@timmo001/kestrel-core/domain";
import { Option, Schema, SchemaGetter } from "effect";

/** The recorder's source, which channel numbers from before camera ids meant. */
const recorderSource = "swann";

const ChannelNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** A channel number from before camera ids, as a number or as text, read as the recorder's camera. */
const OldChannel = Schema.Union([
  ChannelNumber,
  Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
  ),
]).pipe(
  Schema.decodeTo(CameraId, {
    decode: SchemaGetter.transform((channel: number) =>
      cameraId(recorderSource, String(channel)),
    ),
    encode: SchemaGetter.transform((id: string) =>
      Number(cameraParts(id).camera),
    ),
  }),
);

/** A camera in a saved setting or link: its id, or a channel number from before camera ids. */
export const SavedCamera = Schema.Union([CameraId, OldChannel]);

const decodeSavedCamera = Schema.decodeUnknownOption(SavedCamera);

/** Where an old address goes now, or undefined for a current one. */
export const newAddress = (
  url: URL,
  pageNames: ReadonlySet<string>,
): string | undefined => {
  const name = url.hash.slice(1);

  if (url.pathname === "/" && pageNames.has(name) && name !== "live") {
    return `/${name}`;
  }

  const search = url.searchParams;

  if (
    url.pathname !== "/recordings" ||
    (!search.has("channel") && !search.has("channels"))
  ) {
    return undefined;
  }

  const next = new URLSearchParams(search);

  const camera = Option.getOrUndefined(
    decodeSavedCamera(search.get("channel")),
  );

  const cameras = (search.get("channels") ?? "")
    .split(",")
    .flatMap((each) => Option.toArray(decodeSavedCamera(each)));

  next.delete("channel");
  next.delete("channels");

  if (camera !== undefined) next.set("camera", camera);

  if (cameras.length > 0) next.set("cameras", cameras.join(","));

  return `/recordings${next.size > 0 ? `?${next.toString()}` : ""}${url.hash}`;
};
