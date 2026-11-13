/**
 * Live streams from web pages, such as a Twitch channel or a YouTube live
 * stream, as a Kestrel source: live view through go2rtc, with yt-dlp
 * finding each stream's address as it starts.
 *
 * @module
 */
import type { Kind } from "@timmo001/kestrel-core";
import { info, make } from "./Source.ts";

/** The `web` kind of source. */
export const kind: Kind = { info, make };
