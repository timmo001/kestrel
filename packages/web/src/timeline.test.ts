/** Where a press, drag or step on the timeline lands: snapped to a recording or event. */
import { describe, expect, test } from "bun:test";
import { snapTo, snapToward } from "./timeline.ts";

const targets = [
  { start: 100, end: 200 },
  { start: 1000, end: 1005 },
];

describe("snapTo", () => {
  test("a press inside a target keeps its second", () => {
    expect(snapTo(150, targets)).toBe(150);
  });

  test("a press in a gap goes to the nearest point, however far", () => {
    // Nearer the first's end than the second's start
    expect(snapTo(400, targets)).toBe(199);
    // Nearer the second's start
    expect(snapTo(900, targets)).toBe(1000);
    // Before everything, the first start
    expect(snapTo(0, targets)).toBe(100);
    // After everything, the last one's last second
    expect(snapTo(80_000, targets)).toBe(1004);
  });

  test("with nothing to snap to, the second itself", () => {
    expect(snapTo(42, [])).toBe(42);
  });
});

describe("snapToward", () => {
  test("a landing in a gap keeps going the way it moved", () => {
    // Nearer the first's end, but moving on goes to the second's start
    expect(snapToward(400, targets, "end")).toBe(1000);
    // Nearer the second's start, but moving back goes to the first's end
    expect(snapToward(900, targets, "start")).toBe(199);
  });

  test("inside a target keeps its second", () => {
    expect(snapToward(150, targets, "start")).toBe(150);
    expect(snapToward(150, targets, "end")).toBe(150);
  });

  test("with nothing that way, the nearest either way", () => {
    expect(snapToward(50, targets, "start")).toBe(100);
    expect(snapToward(80_000, targets, "end")).toBe(1004);
  });
});
