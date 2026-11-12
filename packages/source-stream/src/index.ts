/**
 * Cameras you list by their stream addresses, as a Kestrel source: live
 * view through go2rtc, from RTSP, RTMP, HLS, MJPEG and the rest it plays,
 * and a still picture for a camera that only has one.
 *
 * @module
 */
import type { Kind } from "@timmo001/kestrel-core";
import { info, make } from "./Source.ts";

/** The `stream` kind of source. */
export const kind: Kind = { info, make };
