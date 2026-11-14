/**
 * The cameras the server has, as the pages show them: loaded once the
 * sources are reachable, and labelled by the name you gave them, else by
 * their source's name for them, with "Channel 3" shortened to "Ch 3". The
 * last list loaded is kept in the browser, so a page loading again can show
 * the cameras before the server answers.
 */
import { Camera, type CameraId } from "@timmo001/kestrel-core";
import { getStorage } from "@timmo001/groundwork-ui/storage.ts";
import { Option, Schema } from "effect";
import { call } from "./api.ts";

const storageKey = "kestrel.cameras";

const Cameras = Schema.fromJsonString(Schema.Array(Camera));

const decodeCameras = Schema.decodeUnknownOption(Cameras);

const encodeCameras = Schema.encodeSync(Cameras);

let known: ReadonlyArray<Camera> = [];

/**
 * The cameras loaded last time, checked, since anyone can edit what's kept,
 * and used for the labels until the server answers; `undefined` when there
 * are none.
 */
export const keptCameras = () => {
  const kept = Option.getOrUndefined(
    decodeCameras(getStorage().get(storageKey)),
  );

  if (kept !== undefined) known = kept;

  return kept;
};

/** Forgets the cameras kept, such as once this browser isn't paired. */
export const forgetCameras = () => getStorage().set(storageKey, undefined);

/** Fetches the cameras, keeping them for the labels and for next time. */
export const loadCameras = async () => {
  known = await call((api) => api.cameras.list());
  getStorage().set(storageKey, encodeCameras(known));

  return known;
};

/**
 * A camera's own short name: its source's name for it, such as "Garden",
 * with a recorder's generic "Channel 3" shortened to "Ch 3".
 */
export const ownLabel = (camera: Camera) =>
  camera.channel !== null && camera.name === `Channel ${camera.channel}`
    ? `Ch ${camera.channel}`
    : camera.name;

/** A camera's short label by its id: the name you gave it, else its own. */
export const cameraLabel = (id: string) => {
  const camera = known.find((each) => each.id === id);

  if (camera === undefined) return id;

  return camera.label ?? ownLabel(camera);
};

/** A camera's id as a file name's part, such as `swann-3`. */
export const fileName = (id: CameraId) => id.replace("/", "-");
