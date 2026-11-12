/**
 * What needs you, gathered from every source, which works out its own: the
 * one status source the CLI and the page read. Each alert is pushed to
 * subscribed phones once, when it starts.
 *
 * @module
 */
import type { Attention as AttentionItem } from "@timmo001/kestrel-core";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { Push } from "./Push.ts";
import { Sources } from "./Sources.ts";

/** How often new alerts are looked for, to push. */
const checkEvery = Duration.seconds(15);

export class Attention extends Context.Service<
  Attention,
  { readonly list: Effect.Effect<Array<AttentionItem>> }
>()("@timmo001/kestrel-server/Attention") {
  static readonly layer = Layer.effect(
    Attention,
    Effect.gen(function* () {
      const sources = yield* Sources;
      const push = yield* Push;

      const list = Effect.forEach(
        sources.all,
        (source) => source.attention,
      ).pipe(Effect.map((lists) => lists.flat()));

      // The alerts already pushed, so each is pushed once when it starts
      let pushed = new Set<string>();

      const pushNewAlerts = Effect.gen(function* () {
        const alerts = (yield* list).filter((item) => item.level === "alert");

        for (const alert of alerts) {
          if (pushed.has(alert.message)) continue;

          yield* push.send({
            title: "Kestrel",
            body: alert.message,
            tone: "warning",
            level: "alert",
            tag: alert.kind,
            link: "./",
          });
        }

        pushed = new Set(alerts.map((alert) => alert.message));
      });

      yield* pushNewAlerts.pipe(
        Effect.repeat(Schedule.spaced(checkEvery)),
        Effect.forkScoped,
      );

      return Attention.of({ list });
    }),
  );
}
