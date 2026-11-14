/** Where a press on the timeline lands: snapped to the nearest recording or event. */
import { describe, expect, test } from "bun:test";
import { snapTo } from "./timeline.ts";

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
