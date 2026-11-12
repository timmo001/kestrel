/**
 * The cameras the server has, as the pages show them: loaded once the
 * sources are reachable, and labelled by the name you gave them, else by
 * their source's name for them, with "Channel 3" shortened to "Ch 3".
 */
import type { Camera, CameraId } from "@timmo001/kestrel-core";
import { call } from "./api.ts";

let known: ReadonlyArray<Camera> = [];

/** Fetches the cameras, keeping them for the labels. */
export const loadCameras = async () => {
  known = await call((api) => api.cameras.list());

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
