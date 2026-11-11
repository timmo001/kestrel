/**
 * The server between the recorder and the web client: the recorder session,
 * live video through go2rtc, and the HTTP API.
 *
 * @module
 */
export * as Api from "./Api.ts";

export { Recorder } from "./Recorder.ts";

export * as Server from "./Server.ts";

export { Video } from "./Video.ts";
