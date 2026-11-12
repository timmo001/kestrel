/**
 * The server between the sources and the web client: live video through
 * go2rtc, and the HTTP API over the source's `Recorder`.
 *
 * @module
 */
export * as Api from "./Api.ts";

export * as Server from "./Server.ts";

export { Video } from "./Video.ts";
