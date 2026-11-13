/**
 * Smart tiling: lays a number of 16:9 tiles out to fill a space as fully as
 * they can, in rows across or columns down, with no empty cells. Where the
 * count doesn't split evenly, the shorter rows or columns come first and
 * their tiles grow to fill them, so five in a wide space is two larger over
 * three.
 */

/** A layout of tiles, in pixels. */
export interface Tiling {
  /** Rows across, or columns down. */
  readonly direction: "rows" | "columns";
  /** How many tiles each row or column holds, in order. */
  readonly lines: ReadonlyArray<number>;
  /** Each row's height, or each column's width. */
  readonly sizes: ReadonlyArray<number>;
  /** The whole grid's size, gaps included. */
  readonly width: number;
  readonly height: number;
  /** How much of the space the pictures cover, gaps left out. */
  readonly area: number;
}

/** `count` split into `parts` as evenly as it goes, the smaller ones first. */
const split = (count: number, parts: number) => {
  const base = Math.floor(count / parts);
  const extra = count % parts;

  return Array.from({ length: parts }, (_, index) =>
    index < parts - extra ? base : base + 1,
  );
};

/**
 * Each way of putting `count` tiles in rows across a `width` × `height`
 * space, each row's tiles side by side across the grid's full width. A row
 * of `k` is `(across - (k - 1) * gap) / (k * ratio)` tall, so the rows'
 * total is a straight line in the grid's width, which gives the widest that
 * still fits the height.
 */
const inRows = (
  count: number,
  width: number,
  height: number,
  ratio: number,
  gap: number,
) =>
  Array.from({ length: count }, (_, index) => {
    const lines = split(count, index + 1);

    const slope = lines.reduce((sum, k) => sum + 1 / (k * ratio), 0);

    const offset =
      lines.reduce((sum, k) => sum + ((k - 1) * gap) / (k * ratio), 0) -
      (lines.length - 1) * gap;

    const across = Math.floor(Math.min(width, (height + offset) / slope));
    const sizes = lines.map((k) => (across - (k - 1) * gap) / (k * ratio));

    return {
      lines,
      sizes,
      across,
      down:
        sizes.reduce((sum, size) => sum + size, 0) + (lines.length - 1) * gap,
      area: lines.reduce(
        (sum, k, line) => sum + k * (sizes[line] ?? 0) ** 2 * ratio,
        0,
      ),
    };
  }).filter(({ sizes }) => sizes.every((size) => size > 0));

/** Areas this close count as the same, so the shape decides between them. */
const nearly = 0.005;

/**
 * The layout that covers most of a `width` × `height` space with `count`
 * tiles at `ratio`, `gap` apart, or `undefined` with no space to fill.
 * Between two that cover about the same, an even one wins over an uneven
 * one, then the one the space's shape suits: wider in a wide space, taller
 * in a tall one.
 */
export const tilingFor = (
  count: number,
  width: number,
  height: number,
  ratio = 16 / 9,
  gap = 2,
): Tiling | undefined => {
  if (count < 1 || width <= 0 || height <= 0) return undefined;

  const candidates: ReadonlyArray<Tiling> = [
    ...inRows(count, width, height, ratio, gap).map((each): Tiling => ({
      direction: "rows",
      lines: each.lines,
      sizes: each.sizes,
      width: each.across,
      height: each.down,
      area: each.area,
    })),
    ...inRows(count, height, width, 1 / ratio, gap).map((each): Tiling => ({
      direction: "columns",
      lines: each.lines,
      sizes: each.sizes,
      width: each.down,
      height: each.across,
      area: each.area,
    })),
  ];

  const wide = width / height >= ratio;
  const even = (each: Tiling) => each.lines.every((k) => k === each.lines[0]);

  return candidates.reduce<Tiling | undefined>((best, each) => {
    if (best === undefined || each.area > best.area * (1 + nearly)) return each;

    if (each.area < best.area * (1 - nearly)) return best;

    if (even(each) !== even(best)) return even(each) ? each : best;

    const wider = each.width / each.height - best.width / best.height;

    return (wide ? wider > 0 : wider < 0) ? each : best;
  }, undefined);
};

/**
 * The least common multiple of the line counts: the grid's tracks along
 * them, so a tile in a line of `k` spans `tracks / k`.
 */
export const tracksFor = (lines: ReadonlyArray<number>) => {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

  return lines.reduce((sum, k) => (sum * k) / gcd(sum, k), 1);
};

const px = (value: number) => `${Math.round(value * 100) / 100}px`;

const cellsOf = (grid: HTMLElement) =>
  [...grid.children].filter((child) => child instanceof HTMLElement);

/** Lays `grid`'s children out as `tiling`, over the styles' own layouts. */
export const applyTiling = (grid: HTMLElement, tiling: Tiling) => {
  const tracks = tracksFor(tiling.lines);
  const along = `repeat(${tracks}, minmax(0, 1fr))`;
  const across = tiling.sizes.map(px).join(" ");
  const rows = tiling.direction === "rows";

  grid.style.width = px(tiling.width);
  grid.style.height = px(tiling.height);
  grid.style.gridTemplateColumns = rows ? along : across;
  grid.style.gridTemplateRows = rows ? across : along;
  grid.style.gridAutoFlow = rows ? "row" : "column";

  const spans = tiling.lines.flatMap((k) =>
    Array.from({ length: k }, () => `span ${tracks / k}`),
  );

  for (const [index, cell] of cellsOf(grid).entries()) {
    const span = spans[index] ?? "auto";

    cell.style.gridColumn = rows ? span : "";
    cell.style.gridRow = rows ? "" : span;
  }
};

/** Hands `grid` back to the styles' own layouts. */
export const clearTiling = (grid: HTMLElement) => {
  for (const name of [
    "width",
    "height",
    "grid-template-columns",
    "grid-template-rows",
    "grid-auto-flow",
  ]) {
    grid.style.removeProperty(name);
  }

  for (const cell of cellsOf(grid)) {
    cell.style.removeProperty("grid-column");
    cell.style.removeProperty("grid-row");
  }
};
