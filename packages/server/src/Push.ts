/**
 * Web Push to phones and browsers, by Groundwork's push contract: the
 * VAPID key and subscription routes, and sending a payload to every
 * subscription. The keys and subscriptions are kept in a file only this user
 * can read, so they survive a restart.
 *
 * @module
 */
import {
  PushSubscription,
  decodePushSubscription,
  decodePushUnsubscribe,
  pushRoutes,
  type PushPayload,
} from "@timmo001/groundwork-pwa/push";
import {
  Cause,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as webPush from "web-push";

const Stored = Schema.Struct({
  vapid: Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String }),
  subscriptions: Schema.Array(PushSubscription),
});

interface Stored extends Schema.Schema.Type<typeof Stored> {}

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));

/** A push service answers 404 or 410 for a subscription that's gone. */
const isGone = ({ cause }: Cause.UnknownError) =>
  cause instanceof webPush.WebPushError &&
  (cause.statusCode === 404 || cause.statusCode === 410);

export class Push extends Context.Service<
  Push,
  {
    /** Sends a payload to every subscription, dropping the ones that are gone. */
    readonly send: (payload: PushPayload) => Effect.Effect<void>;
    /** The push contract's routes. */
    readonly routes: Layer.Layer<never, never, HttpRouter.HttpRouter>;
  }
>()("@timmo001/dvr-revival-server/Push") {
  static readonly layer = Layer.effect(
    Push,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const home = yield* Config.String("HOME").pipe(Config.withDefault("."));

      const directory = yield* Config.String("DVR_REVIVAL_STATE").pipe(
        Config.orElse(() =>
          Config.String("XDG_STATE_HOME").pipe(
            Config.map((state) => path.join(state, "dvr-revival")),
          ),
        ),
        Config.withDefault(path.join(home, ".local/state/dvr-revival")),
      );

      const file = path.join(directory, "push.json");

      const loaded = yield* fs.readFileString(file).pipe(
        Effect.map(decodeStored),
        Effect.orElseSucceed(() => Option.none<Stored>()),
      );

      const state = yield* Ref.make<Stored>(
        Option.getOrElse(loaded, () => ({
          vapid: webPush.generateVAPIDKeys(),
          subscriptions: [],
        })),
      );

      const save = Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });

        yield* fs.writeFileString(file, JSON.stringify(yield* Ref.get(state)), {
          mode: 0o600,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Couldn't save the push subscriptions: ${error.message}`,
          ),
        ),
      );

      if (Option.isNone(loaded)) yield* save;

      const { vapid } = yield* Ref.get(state);

      webPush.setVapidDetails(
        "https://github.com/timmo001/dvr-revival",
        vapid.publicKey,
        vapid.privateKey,
      );

      const send = Effect.fn("Push.send")(function* (payload: PushPayload) {
        const { subscriptions } = yield* Ref.get(state);
        const body = JSON.stringify(payload);

        const gone = yield* Effect.forEach(
          subscriptions,
          (subscription) =>
            Effect.tryPromise(() =>
              webPush.sendNotification(subscription, body),
            ).pipe(
              Effect.as(Option.none<string>()),
              Effect.catch((error) =>
                isGone(error)
                  ? Effect.succeed(Option.some(subscription.endpoint))
                  : Effect.logWarning(
                      `A push to ${subscription.client.name} didn't send`,
                    ).pipe(Effect.as(Option.none<string>())),
              ),
            ),
          { concurrency: 4 },
        ).pipe(Effect.map((results) => results.flatMap(Option.toArray)));

        if (gone.length > 0) {
          yield* Ref.update(state, (stored) => ({
            vapid: stored.vapid,
            subscriptions: stored.subscriptions.filter(
              (subscription) => !gone.includes(subscription.endpoint),
            ),
          }));

          yield* save;
        }
      });

      const noContent = HttpServerResponse.empty({ status: 204 });
      const badRequest = HttpServerResponse.empty({ status: 400 });

      const routes = Layer.mergeAll(
        HttpRouter.add("GET", `/${pushRoutes.vapidKey}`, () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ publicKey: vapid.publicKey }),
          ),
        ),
        HttpRouter.add("POST", `/${pushRoutes.subscriptions}`, (request) =>
          Effect.gen(function* () {
            const subscription = decodePushSubscription(yield* request.text);

            if (subscription === undefined) return badRequest;

            // One subscription per client: a new one replaces its last
            yield* Ref.update(state, (stored) => ({
              vapid: stored.vapid,
              subscriptions: [
                ...stored.subscriptions.filter(
                  (kept) => kept.client.id !== subscription.client.id,
                ),
                subscription,
              ],
            }));

            yield* save;

            return noContent;
          }).pipe(Effect.orElseSucceed(() => badRequest)),
        ),
        HttpRouter.add("DELETE", `/${pushRoutes.subscriptions}`, (request) =>
          Effect.gen(function* () {
            const unsubscribe = decodePushUnsubscribe(yield* request.text);

            if (unsubscribe === undefined) return badRequest;

            yield* Ref.update(state, (stored) => ({
              vapid: stored.vapid,
              subscriptions: stored.subscriptions.filter(
                (kept) => kept.endpoint !== unsubscribe.endpoint,
              ),
            }));

            yield* save;

            return noContent;
          }).pipe(Effect.orElseSucceed(() => badRequest)),
        ),
      );

      return Push.of({ send, routes });
    }),
  );
}
