/**
 * The server's API from the page: a typed client over the same origin, and
 * the live events as server-sent events. Each call says the page's version,
 * which the server must share. A call the server refuses because this
 * browser isn't paired tells `onUnpaired`, and one it refuses because the
 * page is from another version, such as a cached one, tells `onMismatched`.
 */
import { CameraEvent, version, versionHeader } from "@timmo001/kestrel-core";
import { Api } from "@timmo001/kestrel-server/api";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

let whenUnpaired = () => {};

let whenMismatched = () => {};

/** Runs `listener` when the server says this browser isn't paired, such as after it's removed. */
export const onUnpaired = (listener: () => void) => {
  whenUnpaired = listener;
};

/** Runs `listener` when the server runs another version than this page. */
export const onMismatched = (listener: () => void) => {
  whenMismatched = listener;
};

/**
 * An address on the server, under the path the page is served from: the
 * root, or Home Assistant's ingress path, which the page's `<base>` holds.
 * `path` is relative, such as `api/cameras`.
 */
export const serverUrl = (path: string) => new URL(path, document.baseURI);

// Made on each call rather than when the module loads, so modules that only
// need `serverUrl` load without a page, such as in tests
const client = Effect.suspend(() =>
  HttpApiClient.make(Api, {
    baseUrl: serverUrl("./"),
    transformClient: (http) =>
      http.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeader(versionHeader, version),
        ),
        HttpClient.tap((response) =>
          Effect.sync(() => {
            if (response.status === 401) whenUnpaired();

            if (response.status === 426) whenMismatched();
          }),
        ),
      ),
  }),
).pipe(Effect.provide(FetchHttpClient.layer));

type Client = Effect.Success<typeof client>;

/** Runs one call against the server, resolving with its result. */
export const call = <A, E>(use: (api: Client) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(client, use));

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(CameraEvent),
);

/**
 * Listens for events. The browser reconnects by itself when the server
 * drops the stream. Returns a function that stops listening.
 */
export const listenForEvents = (onEvent: (event: CameraEvent) => void) => {
  const source = new EventSource(serverUrl("api/events/live"));

  source.addEventListener("message", (message) => {
    try {
      onEvent(decodeEvent(message.data));
    } catch (error) {
      console.warn("Skipped an event the page couldn't read", error);
    }
  });

  return () => source.close();
};
