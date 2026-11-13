/**
 * The server between the sources and the web client and CLI: the HTTP API
 * over the sources, and live video through go2rtc.
 *
 * @module
 */
export * as Api from "./Api.ts";

export * as Server from "./Server.ts";

export { Sources } from "./Sources.ts";
