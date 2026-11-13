/**
 * Checks when background work waits: the limits that kept the server from
 * taking a small machine's memory, and that a moment's CPU doesn't stop it.
 */
import { defaultLimits } from "@timmo001/kestrel-core";
import { expect, test } from "bun:test";
import type { UsageSample } from "./Api.ts";
import { holdUpFor } from "./Usage.ts";

const megabyte = 1024 * 1024;

/** A quiet 4 GB, 4 core machine, with Kestrel using 100 MB. */
const sample = (change: Partial<UsageSample> = {}): UsageSample => ({
  at: 0,
  memory: 4096 * megabyte,
  memoryFree: 2048 * megabyte,
  swapUsed: 0,
  memoryPressure: 0,
  diskPressure: 0,
  cores: 4,
  load: 0.5,
  kestrelMemory: 100 * megabyte,
  kestrelCpu: 20,
  ...change,
});

test("nothing waits on a quiet machine, or before the first reading", () => {
  expect(holdUpFor(defaultLimits, [sample()])).toBeUndefined();
  expect(holdUpFor(defaultLimits, [])).toBeUndefined();
});

test("work waits while the machine is short of memory", () => {
  expect(
    holdUpFor(defaultLimits, [sample({ memoryFree: 400 * megabyte })]),
  ).toContain("memory free");
  expect(holdUpFor(defaultLimits, [sample({ memoryPressure: 12 })])).toContain(
    "short of memory",
  );
  expect(holdUpFor(defaultLimits, [sample({ diskPressure: 50 })])).toContain(
    "disks are busy",
  );
});

test("work waits while Kestrel itself is over its memory", () => {
  expect(
    holdUpFor(defaultLimits, [sample({ kestrelMemory: 700 * megabyte })]),
  ).toContain("over its 512 MB");
});

test("CPU goes by the last half minute, not a moment's work", () => {
  const busy = sample({ kestrelCpu: 380 });

  expect(holdUpFor(defaultLimits, [sample(), sample(), busy])).toBeUndefined();
  expect(holdUpFor(defaultLimits, [busy, busy, busy])).toContain("of the CPU");
});
