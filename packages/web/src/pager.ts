/**
 * Live's pager: one Layout menu for how many cameras show at once, every
 * count from one to one fewer than there are and All, and how they tile, and
 * beside it, while the layout pages them, which page shows between Previous
 * and Next, with a pick of the others. The count and the page go together,
 * as a table's rows per page sits beside its pages.
 */
import { on } from "@timmo001/groundwork-ui";
import { phCaretLeft, phCaretRight, phSquaresFour } from "./icons.ts";
import { controlIcon, find } from "./shared.ts";
import { tilingItems, tilingOf, type TilingMode } from "./tiling.ts";

/** A layout: how many cameras at once, or all of them. */
export type Layout = number | "all";

/**
 * The layouts worth offering for this many cameras: every count from one up
 * to one fewer than there are, then All, so seven cameras offer 1 to 6 and All.
 */
export const layoutsFor = (cameras: number): Array<Layout> => [
  ...Array.from({ length: Math.max(cameras - 1, 0) }, (_, index) => index + 1),
  "all",
];

/** A layout as the menu names it. */
const layoutName = (layout: Layout, cameras: number) => {
  if (layout === "all") return `All ${cameras}`;

  return layout === 1 ? "1 camera" : `${layout} at once`;
};

/** A layout as the menu's trigger shows it, short, so the pager fits a phone. */
const layoutCount = (layout: Layout) =>
  layout === "all" ? "All" : String(layout);

/** What the pager shows. */
export interface PagerState {
  /** How many cameras there are. */
  readonly cameras: number;
  readonly layout: Layout;
  readonly tiling: TilingMode;
  /** The page showing, from the first. */
  readonly page: number;
  /** Each page's cameras, by name. */
  readonly pages: ReadonlyArray<ReadonlyArray<string>>;
}

export interface Pager {
  readonly show: (state: PagerState) => void;
}

/** The pager, wired to its elements on the Live page. */
export const cameraPager = (options: {
  readonly onLayout: (layout: Layout) => void;
  readonly onTiling: (tiling: TilingMode) => void;
  readonly onPage: (page: number) => void;
  readonly onStep: (by: -1 | 1) => void;
}): Pager => {
  const menu = find("gw-menu-button", "live-layout");
  const pages = find("gw-row", "live-pages");
  const previous = find("gw-button", "live-previous");
  const select = find("gw-select", "live-page");
  const next = find("gw-button", "live-next");

  menu?.setAttribute("icon", phSquaresFour);
  controlIcon(previous, phCaretLeft, { label: "Previous cameras (Page Up)" });
  controlIcon(next, phCaretRight, { label: "Next cameras (Page Down)" });
  previous?.setAttribute("aria-keyshortcuts", "PageUp");
  next?.setAttribute("aria-keyshortcuts", "PageDown");

  if (menu !== null) {
    on(menu, "select", (event) => {
      const { value } = event.detail;
      const tiling = tilingOf(value);

      if (tiling !== undefined) {
        options.onTiling(tiling);
      } else {
        options.onLayout(value === "all" ? "all" : Number(value));
      }
    });
  }

  previous?.addEventListener("click", () => options.onStep(-1));
  next?.addEventListener("click", () => options.onStep(1));

  if (select !== null) {
    on(select, "change", () => options.onPage(Number(select.value)));
  }

  return {
    show: (state) => {
      const single = state.layout === 1;

      if (menu !== null) {
        menu.label = layoutCount(state.layout);
        menu.items = [
          ...layoutsFor(state.cameras).map((each) => ({
            value: String(each),
            label: layoutName(each, state.cameras),
            group: "Cameras at once",
            checked: each === state.layout,
          })),
          ...tilingItems(state.tiling),
        ];
      }

      // The page and the way to the others, only while there's more than one
      if (pages !== null) pages.hidden = state.pages.length <= 1;

      // One at a time lists the cameras by name, else each page's cameras
      if (select !== null) {
        select.label = single ? "Camera" : "Page";
        select.options = state.pages.map((names, index) =>
          single
            ? {
                value: String(index),
                label: names[0] ?? `Camera ${index + 1}`,
                description: `${index + 1} of ${state.pages.length}`,
              }
            : {
                value: String(index),
                label: `${index + 1} of ${state.pages.length}`,
                description: names.join(", "),
              },
        );
        select.value = String(state.page);
      }
    },
  };
};
