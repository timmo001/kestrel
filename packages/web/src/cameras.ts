/**
 * The cameras the server has, as the pages show them: loaded once the
 * sources are reachable, and labelled by the name you gave them, else "Ch 3"
 * for a recorder's channel, else by their source's name for them.
 */
import type { Camera, CameraId } from "@timmo001/kestrel-core";
import { call } from "./api.ts";

let known: ReadonlyArray<Camera> = [];

/** Fetches the cameras, keeping them for the labels. */
export const loadCameras = async () => {
  known = await call((api) => api.cameras.list());

  return known;
};

/** A camera's short label by its id: the name you gave it, else "Ch 3" for a recorder's channel, else its source's name for it. */
export const cameraLabel = (id: string) => {
  const camera = known.find((each) => each.id === id);

  if (camera === undefined) return id;

  if (camera.label !== null) return camera.label;

  return camera.channel === null ? camera.name : `Ch ${camera.channel}`;
};

/** A camera's id as a file name's part, such as `swann-3`. */
export const fileName = (id: CameraId) => id.replace("/", "-");
