/** Checks which recorder states need you, which are pushed as alerts. */
import type { ChannelStatus } from "@timmo001/dvr-revival-rsnet/domain";
import { expect, test } from "bun:test";
import { attentionFor } from "./Attention.ts";

const channel = (number: number, videoLoss: boolean): ChannelStatus => ({
  channel: number,
  recordingEnabled: true,
  recording: true,
  recordingMode: "normal",
  motionEnabled: true,
  motion: false,
  videoLoss,
});

const connected = { connected: true, since: null, error: null };

test("only a camera that had a signal alerts when it loses it", () => {
  const status = {
    time: null,
    disks: [{ disk: 1, state: "full" as const }],
    channels: [channel(1, true), channel(5, true)],
  };

  expect(attentionFor(connected, status, new Set([1]))).toEqual([
    {
      level: "passive",
      kind: "disk",
      message: "Disk 1 is full, so the oldest recordings are recorded over",
    },
    {
      level: "alert",
      kind: "signal",
      message: "Channel 1 has lost its camera's signal",
    },
  ]);
});

test("a lost connection is the only item", () => {
  expect(
    attentionFor(
      { connected: false, since: null, error: "Connection refused" },
      null,
      new Set([1]),
    ),
  ).toEqual([
    {
      level: "alert",
      kind: "connection",
      message: "Can't reach the recorder: Connection refused",
    },
  ]);
});
