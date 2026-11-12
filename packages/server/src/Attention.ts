/**
 * What needs you about each source, worked out from its connection and,
 * for a source with details such as a recorder, a status read every minute:
 * the one status source the CLI and the page read. Each alert is pushed to
 * subscribed phones once, when it starts. Only a camera that had a signal
 * while the server ran counts when its signal goes, so empty channels don't.
 *
 * @module
 */
import type {
  Connection,
  RecorderStatus,
  Source,
  SourceId,
} from "@timmo001/kestrel-core";
import { Context, Duration, Effect, Layer, Ref, Schedule } from "effect";
import type { Attention as AttentionItem } from "./Api.ts";
import { Push } from "./Push.ts";
import { Sources } from "./Sources.ts";

const pollEvery = Duration.minutes(1);

/** The attention items for one source's connection and status. */
export const attentionFor = (
  source: { readonly id: SourceId; readonly name: string },
  connection: Connection,
  status: RecorderStatus | null,
  hadSignal: ReadonlySet<number>,
): Array<AttentionItem> => {
  if (!connection.connected) {
    return [
      {
        source: source.id,
        level: "alert",
        kind: "connection",
        message: `Can't reach ${source.name}${connection.error === null ? "" : `: ${connection.error}`}`,
      },
    ];
  }

  if (status === null) return [];

  const disks = status.disks.flatMap((disk): Array<AttentionItem> => {
    if (disk.state === "ok") return [];

    if (disk.state === "full") {
      return [
        {
          source: source.id,
          level: "passive",
          kind: "disk",
          message: `Disk ${disk.disk} is full, so the oldest recordings are recorded over`,
        },
      ];
    }

    return [
      {
        source: source.id,
        level: "alert",
        kind: "disk",
        message: `Disk ${disk.disk} is ${disk.state}`,
      },
    ];
  });

  const signal = status.channels.flatMap((channel): Array<AttentionItem> =>
    channel.videoLoss && hadSignal.has(channel.channel)
      ? [
          {
            source: source.id,
            level: "alert",
            kind: "signal",
            message: `Channel ${channel.channel} has lost its camera's signal`,
          },
        ]
      : [],
  );

  return [...disks, ...signal];
};

/** One source's latest status and the channels that had a signal. */
interface Watched {
  readonly source: Source;
  readonly latest: Ref.Ref<RecorderStatus | null>;
  readonly hadSignal: Set<number>;
}

export class Attention extends Context.Service<
  Attention,
  { readonly list: Effect.Effect<Array<AttentionItem>> }
>()("@timmo001/kestrel-server/Attention") {
  static readonly layer = Layer.effect(
    Attention,
    Effect.gen(function* () {
      const sources = yield* Sources;
      const push = yield* Push;

      const watched: ReadonlyArray<Watched> = yield* Effect.forEach(
        sources.all,
        (source) =>
          Ref.make<RecorderStatus | null>(null).pipe(
            Effect.map((latest) => ({
              source,
              latest,
              hadSignal: new Set<number>(),
            })),
          ),
      );

      // The alerts already pushed, so each is pushed once when it starts
      let pushed = new Set<string>();

      const listFor = Effect.fnUntraced(function* (each: Watched) {
        return attentionFor(
          each.source,
          yield* each.source.connection,
          yield* Ref.get(each.latest),
          each.hadSignal,
        );
      });

      const list = Effect.forEach(watched, listFor).pipe(
        Effect.map((lists) => lists.flat()),
      );

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

      // Retried within the minute, so the first read doesn't miss the login
      // that's still under way as the server starts
      const read = (each: Watched) => {
        const details = each.source.details;

        if (details === undefined) return Effect.void;

        return details.status.pipe(
          Effect.retry(
            Schedule.spaced(Duration.seconds(5)).pipe(
              Schedule.upTo({ duration: Duration.seconds(55) }),
            ),
          ),
          Effect.tap((status) =>
            Effect.sync(() => {
              for (const channel of status.channels) {
                if (!channel.videoLoss) each.hadSignal.add(channel.channel);
              }
            }),
          ),
          Effect.flatMap((status) => Ref.set(each.latest, status)),
          Effect.catch(() => Ref.set(each.latest, null)),
        );
      };

      yield* Effect.forEach(watched, read, { concurrency: "unbounded" }).pipe(
        Effect.andThen(pushNewAlerts),
        Effect.repeat(Schedule.spaced(pollEvery)),
        Effect.forkScoped,
      );

      return Attention.of({ list });
    }),
  );
}
