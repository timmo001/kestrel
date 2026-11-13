/** Checks smart tiling fills the space the way the fixed layouts would, and more where it can. */
import { expect, test } from "bun:test";
import { tilingFor, tracksFor } from "./tiling.ts";

const linesIn = (count: number, width: number, height: number) => {
  const tiling = tilingFor(count, width, height);

  return tiling === undefined
    ? undefined
    : { direction: tiling.direction, lines: tiling.lines };
};

test("a 16:9 space takes the fixed layouts' shapes", () => {
  expect(linesIn(2, 1600, 900)).toEqual({
    direction: "columns",
    lines: [1, 1],
  });
  // One large, two stacked beside it
  expect(linesIn(3, 1600, 900)).toEqual({
    direction: "columns",
    lines: [1, 2],
  });
  expect(linesIn(4, 1600, 900)).toEqual({
    direction: "columns",
    lines: [2, 2],
  });
  // Two larger over three
  expect(linesIn(5, 1600, 900)).toEqual({ direction: "rows", lines: [2, 3] });
  expect(linesIn(9, 1600, 900)).toEqual({
    direction: "columns",
    lines: [3, 3, 3],
  });
});

test("a tall space stacks the cameras rather than leaving it empty", () => {
  expect(linesIn(2, 800, 1000)).toEqual({ direction: "rows", lines: [1, 1] });
  expect(linesIn(4, 800, 1000)).toEqual({
    direction: "rows",
    lines: [1, 1, 2],
  });
});

test("every camera has a tile, and the grid fits the space", () => {
  for (const [width, height] of [
    [1600, 900],
    [1900, 800],
    [380, 500],
  ] as const) {
    for (let count = 1; count <= 20; count += 1) {
      const tiling = tilingFor(count, width, height);

      expect(tiling?.lines.reduce((sum, k) => sum + k, 0)).toBe(count);
      expect(tiling?.width).toBeLessThanOrEqual(width);
      expect(tiling?.height).toBeLessThanOrEqual(height);
    }
  }
});

test("no space, or no cameras, has no tiling", () => {
  expect(tilingFor(4, 0, 900)).toBeUndefined();
  expect(tilingFor(0, 1600, 900)).toBeUndefined();
});

test("uneven lines share tracks every tile spans whole", () => {
  expect(tracksFor([2, 3])).toBe(6);
  expect(tracksFor([3, 3, 4])).toBe(12);
});
