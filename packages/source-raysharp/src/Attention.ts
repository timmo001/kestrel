/**
 * What needs you about a Raysharp recorder, from its connection and its
 * latest status: a lost connection, a bad or full disk, and a camera that
 * lost its signal. Only a camera that had a signal while the server ran
 * counts when its signal goes, so empty channels don't.
 *
 * @module
 */
import type { Attention, Connection, SourceId } from "@timmo001/kestrel-core";
import type { RecorderStatus } from "@timmo001/kestrel-protocol-raysharp";

/** The attention items for one recorder's connection and status. */
export const attentionFor = (
  source: { readonly id: SourceId; readonly name: string },
  connection: Connection,
  status: RecorderStatus | null,
  hadSignal: ReadonlySet<number>,
): Array<Attention> => {
  // Not tried yet, as the server starts: nothing to say until the first
  // login works or fails
  if (!connection.connected && connection.since === null) return [];

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

  const disks = status.disks.flatMap((disk): Array<Attention> => {
    if (disk.state === "ok") return [];

    if (disk.state === "full") {
      return [
        {
          source: source.id,
          level: "passive",
          kind: "storage",
          message: `Disk ${disk.disk} is full, so the oldest recordings are recorded over`,
        },
      ];
    }

    return [
      {
        source: source.id,
        level: "alert",
        kind: "storage",
        message: `Disk ${disk.disk} is ${disk.state}`,
      },
    ];
  });

  const signal = status.channels.flatMap((channel): Array<Attention> =>
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
