/**
 * How the recordings folder is laid out: a folder per camera, by its key,
 * marked so clearing out only ever touches those, holding a folder per day
 * of files named by the local time each starts, with any tags after it, such
 * as `front-door/1/2026-11-12/14-02-33.motion.mp4`.
 *
 * @module
 */
import { Data } from "effect";

/** The file each camera's folder holds, so clearing out only ever touches those. */
export const marker = ".kestrel-recordings";

export const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/** A file's start time and any tags, such as `14-02-33.motion+pir.mp4`. */
export const filePattern =
  /^(\d{2})-(\d{2})-(\d{2})(?:\.([a-z0-9-]+(?:\+[a-z0-9-]+)*))?\.mp4$/;

const keyPattern = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

const tagPattern = /^[a-z0-9-]+$/;

/** A key that isn't lower-case words joined by slashes, which could reach outside the folder. */
export class InvalidKey extends Data.TaggedError("InvalidKey")<{
  readonly key: string;
}> {}

/** Whether a key is safe to make a folder from. */
export const isKey = (key: string) => keyPattern.test(key);

/** The local day of a time, such as `2026-11-12`. */
export const localDate = (millis: number) => {
  const date = new Date(millis);

  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
};

/** A file's name from its start time, such as `14:02:33`, and tags, which must be lower-case words. */
export const fileName = (time: string, tags: ReadonlyArray<string>) => {
  const kept = tags.filter((tag) => tagPattern.test(tag));
  const start = time.replaceAll(":", "-");

  return kept.length === 0 ? `${start}.mp4` : `${start}.${kept.join("+")}.mp4`;
};
