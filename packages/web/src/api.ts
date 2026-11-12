/**
 * The server's API from the page: a typed client over the same origin, and
 * the live alarm reports as server-sent events.
 */
import { Api, ReceivedEvent } from "@timmo001/kestrel-server/api";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

const client = HttpApiClient.make(Api, { baseUrl: location.origin }).pipe(
  Effect.provide(FetchHttpClient.layer),
);

type Client = Effect.Success<typeof client>;

/** Runs one call against the server, resolving with its result. */
export const call = <A, E>(use: (api: Client) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(client, use));

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(ReceivedEvent),
);

/**
 * Listens for alarm reports. The browser reconnects by itself when the
 * server drops the stream. Returns a function that stops listening.
 */
export const listenForEvents = (onEvent: (event: ReceivedEvent) => void) => {
  const source = new EventSource(new URL("api/events/live", location.origin));

  source.addEventListener("message", (message) => {
    try {
      onEvent(decodeEvent(message.data));
    } catch (error) {
      console.warn("Skipped an alarm report the page couldn't read", error);
    }
  });

  return () => source.close();
};
