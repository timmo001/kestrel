/**
 * The picture zoom Live and Recordings share. Each camera's picture is fitted
 * whole, fills its tile, or is zoomed on from either, 25% at a time: the
 * picked camera's from the buttons and keys, or the one under the pointer
 * with Ctrl and the wheel or a pinch. A picture bigger than its tile, filled
 * or zoomed, moves around by dragging, unless its camera is being steered,
 * which takes the drag. The page holds each camera's zoom, so
 * it decides whether it's kept: Live keeps it, Recordings doesn't.
 */
import { on } from "@timmo001/groundwork-ui";
import { phArrowsInSimple, phArrowsOutSimple } from "./icons.ts";

/** How far a picture zooms in, 25% at a time up to 800%. */
const pictureZooms = Array.from({ length: 29 }, (_, index) => 1 + index / 4);

/** How near two zooms are to count as the same, such as Fill and 100%. */
const zoomSlack = 0.01;

/**
 * A picture's zoom: `"fill"` to cover its tile, else a scale of it fitted
 * whole, and how far it's been dragged off centre, as a share of its tile,
 * so it holds the same place in a tile of another size.
 */
export interface PictureView {
  level: number | "fill";
  pan: { x: number; y: number };
}

/** A camera's tile, as the zoom sees it. */
export interface ZoomTile {
  readonly id: string;
  readonly figure: HTMLElement;
  /** What moves and scales with the zoom, such as its video and held frame. */
  readonly parts: ReadonlyArray<HTMLElement>;
  /** Its picture's size as drawn whole, or nothing across until it's known. */
  readonly size: () => { readonly width: number; readonly height: number };
}

export interface ZoomOptions {
  /** The tiles' grid, where the wheel and drags are caught. */
  readonly area: HTMLElement | null;
  readonly tiles: () => ReadonlyArray<ZoomTile>;
  /** The picked camera's tile, which the buttons and keys act on. */
  readonly picked: () => ZoomTile | undefined;
  /** Each camera's zoom by its id, held by the page. */
  readonly views: () => Map<string, PictureView>;
  readonly zoomOut: HTMLElementTagNameMap["gw-button"] | null;
  /** Shows the zoom, and goes back to the whole picture. */
  readonly zoomFit: HTMLElementTagNameMap["gw-button"] | null;
  readonly zoomIn: HTMLElementTagNameMap["gw-button"] | null;
  /** Fit or Fill, for the picked camera. */
  readonly fit: HTMLElementTagNameMap["gw-segmented"] | null;
  /** The wheel or a drag on a tile, which can pick it. */
  readonly onPick?: (tile: ZoomTile) => void;
  /** Whether a gesture on a tile steers its camera instead, so the zoom steps aside. */
  readonly steers?: (tile: ZoomTile, gesture: "drag" | "wheel") => boolean;
  /** A zoom changed, for the page to keep. */
  readonly onChange?: () => void;
}

export interface PictureZoom {
  /** Shows each picture at its zoom, and the controls to match. */
  readonly show: () => void;
  /** Zooms the picked camera a step in or out. */
  readonly step: (by: -1 | 1) => void;
  /** Back to the picked camera's whole picture. */
  readonly whole: () => void;
  /** Fills the picked camera's tile, or fits it whole again. */
  readonly toggleFill: () => void;
}

/** Wires the zoom for a page's tiles and controls. */
export const pictureZoom = (options: ZoomOptions): PictureZoom => {
  const { area, zoomOut, zoomFit, zoomIn, fit } = options;

  const viewOf = (tile: ZoomTile) => {
    const found = options.views().get(tile.id);

    if (found !== undefined) return found;

    // Each picture starts whole
    const view: PictureView = { level: 1, pan: { x: 0, y: 0 } };

    options.views().set(tile.id, view);

    return view;
  };

  /**
   * Where a tile's picture sits: its tile, its scale from fitted whole, and
   * how far it reaches past the tile each way, as a share of the tile, so
   * how far it can move. Its reach is only known once its picture is.
   */
  const placeOf = (tile: ZoomTile) => {
    const box = tile.figure.getBoundingClientRect();
    const picture = tile.size();

    const known =
      picture.width > 0 &&
      picture.height > 0 &&
      box.width > 0 &&
      box.height > 0;

    const across = known ? box.width / picture.width : 1;
    const down = known ? box.height / picture.height : 1;
    const fitted = Math.min(across, down);
    const fillScale = Math.max(across, down) / fitted;
    const { level } = viewOf(tile);
    const scale = level === "fill" ? fillScale : level;

    return {
      box,
      scale,
      /** The scale that covers the tile, one of the zoom's steps. */
      fillScale,
      known,
      reachX: known ? Math.max(0, (fitted * scale) / across - 1) / 2 : 0,
      reachY: known ? Math.max(0, (fitted * scale) / down - 1) / 2 : 0,
    };
  };

  /**
   * Whether the picked camera covers its tile: filled, or zoomed in as far
   * or further. Whole, a picture the tile's own shape only fits it.
   */
  const filled = () => {
    const tile = options.picked();

    if (tile === undefined) return false;

    const { scale, fillScale } = placeOf(tile);
    const zoomedIn = viewOf(tile).level === "fill" || scale > 1 + zoomSlack;

    return zoomedIn && scale > fillScale - zoomSlack;
  };

  const show = () => {
    for (const tile of options.tiles()) {
      const view = viewOf(tile);
      const { box, scale, known, reachX, reachY } = placeOf(tile);

      // Until its picture's known, a kept place waits rather than resets
      if (known) {
        view.pan = {
          x: Math.min(Math.max(view.pan.x, -reachX), reachX),
          y: Math.min(Math.max(view.pan.y, -reachY), reachY),
        };
      }

      const x = view.pan.x * box.width;
      const y = view.pan.y * box.height;

      const transform =
        scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;

      for (const part of tile.parts) part.style.transform = transform;

      // Less than a pixel to move isn't worth a drag
      tile.figure.toggleAttribute(
        "data-movable",
        reachX * box.width >= 1 || reachY * box.height >= 1,
      );
    }

    const tile = options.picked();
    const scale = tile === undefined ? 1 : placeOf(tile).scale;

    if (fit !== null) fit.value = filled() ? "fill" : "fit";

    if (zoomFit !== null) {
      zoomFit.textContent = `${Math.round(scale * 100)}%`;
      zoomFit.disabled = scale <= 1;
    }

    if (zoomOut !== null) zoomOut.disabled = scale <= 1;

    if (zoomIn !== null) {
      zoomIn.disabled =
        tile === undefined || scale >= (pictureZooms.at(-1) ?? 1);
    }
  };

  /**
   * Zooms a picture to `next`, keeping the point at `at` (from its tile's
   * middle, as a share of it) where it is.
   */
  const zoomTo = (
    tile: ZoomTile | undefined,
    next: number | "fill",
    at = { x: 0, y: 0 },
  ) => {
    if (tile === undefined) return;

    const view = viewOf(tile);
    const { scale, fillScale } = placeOf(tile);
    const to = next === "fill" ? fillScale : next;

    view.pan = {
      x: at.x - ((at.x - view.pan.x) / scale) * to,
      y: at.y - ((at.y - view.pan.y) / scale) * to,
    };
    view.level = next;
    show();
    options.onChange?.();
  };

  /**
   * Zooms a picture a step in or out from where it is. Filling its tile is
   * one of the steps, so Z and the zoom go through the same levels.
   */
  const zoomStep = (
    tile: ZoomTile | undefined,
    by: -1 | 1,
    at?: { x: number; y: number },
  ) => {
    if (tile === undefined) return;

    const { scale, fillScale } = placeOf(tile);

    const scaleOf = (step: number | "fill") =>
      step === "fill" ? fillScale : step;

    // Fill's a step of its own where it isn't the whole picture
    const steps = [...pictureZooms, "fill" as const]
      .filter((each) => each !== "fill" || fillScale > 1 + zoomSlack)
      .toSorted((a, b) => scaleOf(a) - scaleOf(b));

    const next =
      by > 0
        ? steps.find((each) => scaleOf(each) > scale + zoomSlack)
        : steps.filter((each) => scaleOf(each) < scale - zoomSlack).at(-1);

    if (next !== undefined) zoomTo(tile, next, at);
  };

  /** Fills the picked camera's tile, or fits it whole, from the middle. */
  const setFill = (next: boolean) => {
    const tile = options.picked();

    if (tile === undefined) return;

    options.views().set(tile.id, {
      level: next ? "fill" : 1,
      pan: { x: 0, y: 0 },
    });
    show();
    options.onChange?.();
  };

  zoomIn?.addEventListener("click", () => zoomStep(options.picked(), 1));
  zoomOut?.addEventListener("click", () => zoomStep(options.picked(), -1));
  zoomFit?.addEventListener("click", () => zoomTo(options.picked(), 1));

  if (fit !== null) {
    fit.options = [
      {
        value: "fit",
        label: "Fit",
        icon: phArrowsInSimple,
        hint: "Fit: the picked camera's whole picture (Z)",
      },
      {
        value: "fill",
        label: "Fill",
        icon: phArrowsOutSimple,
        hint: "Fill: the picked camera zoomed to its tile (Z)",
      },
    ];
    fit.setAttribute("aria-keyshortcuts", "z");
    on(fit, "change", () => setFill(fit.value === "fill"));
  }

  /** The tile a pointer event is on. */
  const tileAt = (event: Event) =>
    options.tiles().find((tile) => event.composedPath().includes(tile.figure));

  /** A pointer's place from the middle of a tile, as a share of it. */
  const fromMiddle = (event: MouseEvent, tile: ZoomTile) => {
    const box = tile.figure.getBoundingClientRect();

    return {
      x: (event.clientX - box.left) / box.width - 0.5,
      y: (event.clientY - box.top) / box.height - 0.5,
    };
  };

  // Only Ctrl with the wheel, or a trackpad pinch, which browsers send as
  // that, zooms; a plain scroll scrolls the page. The small events of a
  // notch or a pinch add up to a step at a time
  const wheelStep = 50;
  let wheeled = 0;

  area?.addEventListener(
    "wheel",
    (event) => {
      const tile = tileAt(event);

      if (
        !event.ctrlKey ||
        tile === undefined ||
        options.steers?.(tile, "wheel") === true
      ) {
        return;
      }

      event.preventDefault();
      options.onPick?.(tile);
      wheeled += event.deltaY;

      if (Math.abs(wheeled) < wheelStep) return;

      zoomStep(tile, wheeled < 0 ? 1 : -1, fromMiddle(event, tile));
      wheeled = 0;
    },
    { passive: false },
  );

  // A drag on a picture bigger than its tile moves it around
  let drag:
    | { tile: ZoomTile; x: number; y: number; pan: { x: number; y: number } }
    | undefined;

  /** Controls over a picture, where a press never moves it. */
  const controls = "gw-button, gw-range, gw-switch, gw-input, gw-select";

  area?.addEventListener("pointerdown", (event) => {
    const tile = tileAt(event);

    if (
      tile === undefined ||
      !tile.figure.hasAttribute("data-movable") ||
      options.steers?.(tile, "drag") === true ||
      event
        .composedPath()
        .some((target) => target instanceof Element && target.matches(controls))
    ) {
      return;
    }

    drag = { tile, x: event.clientX, y: event.clientY, pan: viewOf(tile).pan };
    options.onPick?.(tile);
  });

  // The window follows the drag, so it goes on past the tile, while clicks
  // still land on the tile for a double click
  window.addEventListener("pointermove", (event) => {
    if (drag === undefined) return;

    const box = drag.tile.figure.getBoundingClientRect();

    viewOf(drag.tile).pan = {
      x: drag.pan.x + (event.clientX - drag.x) / box.width,
      y: drag.pan.y + (event.clientY - drag.y) / box.height,
    };
    show();
  });

  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, () => {
      if (drag === undefined) return;

      drag = undefined;
      options.onChange?.();
    });
  }

  // How much Fill zooms and how far a picture reaches follow its size and
  // its tile's, known once its first frame is. Media events don't bubble,
  // so the grid listens as they pass down
  for (const type of ["loadedmetadata", "resize"]) {
    area?.addEventListener(type, () => show(), { capture: true });
  }

  window.addEventListener("resize", () => show());

  return {
    show,
    step: (by) => zoomStep(options.picked(), by),
    whole: () => zoomTo(options.picked(), 1),
    toggleFill: () => setFill(!filled()),
  };
};
