/**
 * Raysharp-made recorders, such as the Swann DVR8-4575, as a Kestrel
 * source: each channel a camera, over the recorder's control protocol and
 * its RTSP streams.
 *
 * @module
 */
import type { Kind } from "@timmo001/kestrel-core";
import { info, make } from "./Source.ts";

/** The `raysharp` kind of source. */
export const kind: Kind = { info, make };
