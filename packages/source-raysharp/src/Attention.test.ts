/** Checks which recorder states need you, which are pushed as alerts. */
import type { ChannelStatus } from "@timmo001/kestrel-protocol-raysharp";
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

const source = { id: "swann", name: "Swann recorder" };

test("only a camera that had a signal alerts when it loses it", () => {
  const status = {
    time: null,
    disks: [{ disk: 1, state: "full" as const }],
    channels: [channel(1, true), channel(5, true)],
  };

  expect(attentionFor(source, connected, status, new Set([1]))).toEqual([
    {
      source: "swann",
      level: "passive",
      kind: "storage",
      message: "Disk 1 is full, so the oldest recordings are recorded over",
    },
    {
      source: "swann",
      level: "alert",
      kind: "signal",
      message: "Channel 1 has lost its camera's signal",
    },
  ]);
});

test("a lost connection is the only item", () => {
  expect(
    attentionFor(
      source,
      {
        connected: false,
        since: "2026-11-12T13:00:00.000Z",
        error: "Connection refused",
      },
      null,
      new Set([1]),
    ),
  ).toEqual([
    {
      source: "swann",
      level: "alert",
      kind: "connection",
      message: "Can't reach Swann recorder: Connection refused",
    },
  ]);
});

test("nothing needs you while the first login is still under way", () => {
  expect(
    attentionFor(
      source,
      { connected: false, since: null, error: null },
      null,
      new Set(),
    ),
  ).toEqual([]);
});
