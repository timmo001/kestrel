/**
 * Reolink cameras, hubs and recorders, as a Kestrel source: live view
 * through go2rtc from their RTSP streams, stills, and motion and person,
 * vehicle and animal detections as events.
 *
 * @module
 */
import type { Kind } from "@timmo001/kestrel-core";
import { info, make } from "./Source.ts";

/** The `reolink` kind of source. */
export const kind: Kind = { info, make };
