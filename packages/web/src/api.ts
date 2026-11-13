/**
 * The server's API from the page: a typed client over the same origin, and
 * the live events as server-sent events. A call the server refuses because
 * this browser isn't paired tells `onUnpaired`.
 */
import { CameraEvent } from "@timmo001/kestrel-core";
import { Api } from "@timmo001/kestrel-server/api";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

let whenUnpaired = () => {};

/** Runs `listener` when the server says this browser isn't paired, such as after it's removed. */
export const onUnpaired = (listener: () => void) => {
  whenUnpaired = listener;
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
    transformClient: HttpClient.tap((response) =>
      Effect.sync(() => {
        if (response.status === 401) whenUnpaired();
      }),
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
