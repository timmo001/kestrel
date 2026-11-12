/**
 * How sources and cameras are named: a source's id, such as `swann`, and a
 * camera's, its source's id and its own, such as `swann/3`. Neither ever
 * changes, since links and saved settings are made from them.
 *
 * @module
 */
import { Schema } from "effect";

/** A source's id: lower-case letters, digits and dashes, such as `swann`. */
export const SourceId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);

export type SourceId = typeof SourceId.Type;

/** A camera's own id within its source, such as `3` in `swann/3`. */
export const CameraKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);

/** A camera's id: its source's id and its own, such as `swann/3`. */
export const CameraId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
);

export type CameraId = typeof CameraId.Type;

/** A camera's id from its source's id and its own, such as `swann/3`. */
export const cameraId = (source: SourceId, camera: string): CameraId =>
  `${source}/${camera}`;

/** A camera id's two parts: its source's id and its own within it. */
export const cameraParts = (id: CameraId) => {
  const slash = id.indexOf("/");

  return { source: id.slice(0, slash), camera: id.slice(slash + 1) };
};
