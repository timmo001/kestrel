/**
 * What needs you about the recorder, worked out from its connection and a
 * status read every minute: the one status source the CLI and the page read.
 * Each alert is pushed to subscribed phones once, when it starts. Only a
 * camera that had a signal while the server ran counts when its signal goes,
 * so empty channels don't.
 *
 * @module
 */
import type { RecorderStatus } from "@timmo001/dvr-revival-rsnet/domain";
import { Context, Duration, Effect, Layer, Ref, Schedule } from "effect";
import type { Attention as AttentionItem, Connection } from "./Api.ts";
import { Push } from "./Push.ts";
import { Recorder } from "./Recorder.ts";

const pollEvery = Duration.minutes(1);

/** The attention items for one connection and status. */
export const attentionFor = (
  connection: Connection,
  status: RecorderStatus | null,
  hadSignal: ReadonlySet<number>,
): Array<AttentionItem> => {
  if (!connection.connected) {
    return [
      {
        level: "alert",
        kind: "connection",
        message: `Can't reach the recorder${connection.error === null ? "" : `: ${connection.error}`}`,
      },
    ];
  }

  if (status === null) return [];

  const disks = status.disks.flatMap((disk): Array<AttentionItem> => {
    if (disk.state === "ok") return [];

    if (disk.state === "full") {
      return [
        {
          level: "passive",
          kind: "disk",
          message: `Disk ${disk.disk} is full, so the oldest recordings are recorded over`,
        },
      ];
    }

    return [
      {
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
            level: "alert",
            kind: "signal",
            message: `Channel ${channel.channel} has lost its camera's signal`,
          },
        ]
      : [],
  );

  return [...disks, ...signal];
};

export class Attention extends Context.Service<
  Attention,
  { readonly list: Effect.Effect<Array<AttentionItem>> }
>()("@timmo001/dvr-revival-server/Attention") {
  static readonly layer = Layer.effect(
    Attention,
    Effect.gen(function* () {
      const recorder = yield* Recorder;
      const push = yield* Push;
      const latest = yield* Ref.make<RecorderStatus | null>(null);
      const hadSignal = new Set<number>();
      // The alerts already pushed, so each is pushed once when it starts
      let pushed = new Set<string>();

      const pushNewAlerts = Effect.gen(function* () {
        const alerts = attentionFor(
          yield* recorder.connection,
          yield* Ref.get(latest),
          hadSignal,
        ).filter((item) => item.level === "alert");

        for (const alert of alerts) {
          if (pushed.has(alert.message)) continue;

          yield* push.send({
            title: "DVR Revival",
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
      const read = recorder.status.pipe(
        Effect.retry(
          Schedule.spaced(Duration.seconds(5)).pipe(
            Schedule.upTo({ duration: Duration.seconds(55) }),
          ),
        ),
        Effect.tap((status) =>
          Effect.sync(() => {
            for (const channel of status.channels) {
              if (!channel.videoLoss) hadSignal.add(channel.channel);
            }
          }),
        ),
        Effect.flatMap((status) => Ref.set(latest, status)),
        Effect.catch(() => Ref.set(latest, null)),
      );

      yield* read.pipe(
        Effect.andThen(pushNewAlerts),
        Effect.repeat(Schedule.spaced(pollEvery)),
        Effect.forkScoped,
      );

      return Attention.of({
        list: Effect.gen(function* () {
          return attentionFor(
            yield* recorder.connection,
            yield* Ref.get(latest),
            hadSignal,
          );
        }),
      });
    }),
  );
}
