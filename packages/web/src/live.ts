/**
 * The Live page: every camera with a signal at once, or a layout's worth at a
 * time (any count from one to one fewer than there are), paged with
 * Previous and Next or picked from the page list, under one set of controls:
 * pause, zoom (fit, fill or a step at a time, each camera its own), a still
 * of the picked camera, full screen and keys. The arrow keys move the pick,
 * on to the next page past the edge. The layout, page, picked camera, each
 * camera's zoom and how many cameras there were are kept in this
 * browser, so the placeholders take the cameras' places before they're
 * known. The players only run while the page shows, so a hidden page
 * streams nothing.
 */
import type { Camera, LiveStreams } from "@timmo001/kestrel-core";
import { go2rtcPath } from "@timmo001/kestrel-server/api";
import { on } from "@timmo001/groundwork-ui";
import { keep, keptAt } from "@timmo001/groundwork-ui/kept.ts";
import { Option, Schema } from "effect";
import { SavedCamera } from "./addresses.ts";
import { cameraLabel, fileName } from "./cameras.ts";
import {
  phArrowsInSimple,
  phArrowsOutSimple,
  phCamera,
  phCaretLeft,
  phCaretRight,
  phCornersIn,
  phCornersOut,
  phMagnifyingGlassMinus,
  phMagnifyingGlassPlus,
  phPause,
  phPlay,
  phQuestion,
} from "./icons.ts";
import {
  controlKey,
  element,
  find,
  helpToggle,
  pictureZooms,
  typingTargets,
} from "./shared.ts";

/** go2rtc's player element, as far as the page uses it. */
interface LivePlayer extends HTMLElement {
  /** How it plays: MSE over the WebSocket, falling back to HLS. */
  mode: string;
  /** The tracks it asks for. */
  media: string;
  /** The stream's WebSocket URL; setting it connects. */
  src: string;
  /** Closes the stream, without reconnecting. */
  ondisconnect: () => void;
}

declare global {
  interface HTMLElementTagNameMap {
    "dvr-live": LivePlayer;
  }
}

/** What the page uses from go2rtc's `video-rtc.js`. */
interface VideoRtcModule {
  readonly VideoRTC: CustomElementConstructor;
}

/**
 * Defines `dvr-live` from go2rtc's own `video-rtc.js`, served beside it, so
 * the player always matches the go2rtc that sends the stream.
 */
const definePlayer = async (path: string) => {
  if (customElements.get("dvr-live") !== undefined) return;

  const url = new URL(`${path}video-rtc.js`, location.origin).href;

  const { VideoRTC }: VideoRtcModule = await import(url);

  if (customElements.get("dvr-live") === undefined) {
    customElements.define("dvr-live", VideoRTC);
  }
};

/** The counts with a grid of their own in the styles, such as three's one large and two beside it. */
const styledLayouts = [1, 2, 3, 4, 5, 6, 9, 16];

/** The most cameras a digit key picks at once. */
const keyedLayouts = 9;

/** A layout: how many cameras at once, or all of them. */
type Layout = number | "all";

/**
 * The layouts worth offering for this many cameras: every count from one up
 * to one fewer than there are, then All, so seven cameras offer 1 to 6 and All.
 */
const layoutsFor = (cameras: number): Array<Layout> => [
  ...Array.from({ length: Math.max(cameras - 1, 0) }, (_, index) => index + 1),
  "all",
];

/** A layout's tooltip. */
const layoutHint = (layout: Layout) => {
  if (layout === "all") return "Every camera at once";

  return layout === 1 ? "One camera" : `${layout} cameras at once`;
};

/**
 * The grid for `count` cameras at once: its own shape where it has one, else
 * columns and rows as near square as they go.
 */
const gridFor = (count: number) => {
  if (styledLayouts.includes(count)) {
    return { layout: String(count), columns: null, rows: null };
  }

  const columns = Math.ceil(Math.sqrt(count));

  return { layout: "all", columns, rows: Math.ceil(count / columns) };
};

/**
 * Past four at once, the small sub stream where there is one: the main one
 * is more than a small tile shows. `ratio` is the shape to draw it at when
 * its frames squeeze the picture into another, else `null`.
 */
const streamFor = (live: LiveStreams, count: number) =>
  count > 4 && live.sub !== null
    ? { name: live.sub, ratio: live.subRatio }
    : { name: live.main, ratio: null };

/** A frame's size drawn at `ratio`, from its height, or as it is without one. */
const drawnSize = (width: number, height: number, ratio: number | null) => ({
  width: ratio === null ? width : Math.round(height * ratio),
  height,
});

/** How often a camera with only a still picture shows a new one. */
const stillEvery = 5000;

/** How near two zooms are to count as the same, such as Fill and 100%. */
const zoomSlack = 0.01;

/** A camera's still picture now; the time makes each one new to the browser. */
const stillAddress = (camera: Camera) =>
  new URL(`api/cameras/${camera.id}/still?at=${Date.now()}`, location.origin)
    .href;

/** The size of what a still is saved from. */
const sizeOf = (
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
) => {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }

  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }

  return { width: source.width, height: source.height };
};

const storageKey = "kestrel.live";

const decodeSavedCamera = Schema.decodeUnknownOption(SavedCamera);

/** Each camera's zoom as kept, by its id. */
const KeptViews = Schema.Record(
  Schema.String,
  Schema.Struct({
    level: Schema.Union([
      Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
      Schema.Literal("fill"),
    ]),
    x: Schema.Number,
    y: Schema.Number,
  }),
);

const decodeKeptViews = Schema.decodeUnknownOption(KeptViews);

/** What's kept, each part checked, since anyone can edit it. */
const kept = () => {
  const values = keptAt(storageKey);
  const layout = Number(values?.["layout"]);
  const page = Number(values?.["page"]);
  const count = Number(values?.["count"]);

  /** All until a paged one's picked, so every camera shows at first. */
  const keptLayout: Layout =
    Number.isInteger(layout) && layout >= 1 ? layout : "all";

  return {
    layout: keptLayout,
    page: Number.isInteger(page) && page >= 0 ? page : 0,
    /** How many cameras there were last time, for the placeholders' shape. */
    count: Number.isInteger(count) && count > 0 ? count : 4,
    // Kept before camera ids, the recorder's channel by number
    picked: Option.getOrUndefined(decodeSavedCamera(values?.["picked"])),
    /** Each camera's zoom and where it was moved to, in tiles of several. */
    views: Option.getOrElse(decodeKeptViews(values?.["views"]), () => ({})),
    /** The same, with one camera at a time. */
    singleViews: Option.getOrElse(
      decodeKeptViews(values?.["singleViews"]),
      () => ({}),
    ),
  };
};

/** A camera on the page: its tile, its player or still picture, and held frame. */
interface Tile {
  readonly stream: Camera;
  readonly figure: HTMLElement;
  /** Its player, for a camera that plays live. */
  readonly player: LivePlayer | null;
  /** Its picture, for a camera with only a still one. */
  readonly picture: HTMLImageElement | null;
  readonly hold: HTMLCanvasElement;
  /** The shape to draw its video at, for a squeezed sub stream; else `null`. */
  readonly ratio: number | null;
}

/**
 * A picture's zoom: `"fill"` to cover its tile, else a scale of it fitted
 * whole, and how far it's been dragged off centre, as a share of its tile,
 * so it holds the same place in a tile of another size.
 */
interface View {
  level: number | "fill";
  pan: { x: number; y: number };
}

/** The local time as a file name's part, such as `2026-11-12T10-30-05`. */
const fileTime = () => {
  const now = new Date();

  const pad = (part: number) => String(part).padStart(2, "0");

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

export interface LivePage {
  /** Shows the cameras that play live and have a signal, once the page is the one shown. */
  readonly show: (cameras: ReadonlyArray<Camera>) => Promise<void>;
  /** Takes the players off the page, which closes their streams. */
  readonly stop: () => void;
  /** Gives the cameras the focus, so the keyboard controls work at once. */
  readonly focus: () => void;
}

/** The Live page, wired to its elements. */
export const livePage = (): LivePage => {
  const stage = find("div", "live-stage");
  const grid = find("div", "live-grid");
  const layoutToggle = find("gw-segmented", "live-layout");
  const previousButton = find("gw-button", "live-previous");
  const playButton = find("gw-button", "live-play");
  const nextButton = find("gw-button", "live-next");
  const pageSelect = find("gw-select", "live-page");
  const zoomOutButton = find("gw-button", "live-zoom-out");
  const zoomFitButton = find("gw-button", "live-zoom-fit");
  const zoomInButton = find("gw-button", "live-zoom-in");
  const fitToggle = find("gw-segmented", "live-fit");
  const captureButton = find("gw-button", "live-capture");
  const helpButton = find("gw-button", "live-help");
  const fullscreenButton = find("gw-button", "live-fullscreen");
  const shortcutsPopover = find("gw-popover", "live-shortcuts");
  const section = stage?.closest("section");

  const saved = kept();
  let layout: Layout = saved.layout;
  let page = saved.page;
  // Several cameras start with none picked, so none is marked out
  let picked = saved.layout === 1 ? saved.picked : undefined;
  /** Where to go back to from one camera alone, by Enter or a double click. */
  let solo: { readonly layout: Layout; readonly page: number } | undefined;
  let paused = false;
  let streams: ReadonlyArray<Camera> = [];
  let tiles: ReadonlyArray<Tile> = [];
  /** Whether the cameras are known, rather than guessed from last time. */
  let loaded = false;

  /** Each camera's zoom from a views kept, by camera id. */
  const viewsFrom = (kept: typeof saved.views) =>
    new Map<string, View>(
      Object.entries(kept).map(([id, view]) => [
        id,
        { level: view.level, pan: { x: view.x, y: view.y } },
      ]),
    );

  /**
   * Each camera's zoom, kept from last time: one set for the tiles of
   * several at once, another for one camera at a time, so a camera zoomed
   * in its tile can still show whole on its own.
   */
  const views = {
    tiles: viewsFrom(saved.views),
    single: viewsFrom(saved.singleViews),
  };

  /** The zooms the page shows now, by how many cameras it shows at once. */
  const viewsNow = () => (size() === 1 ? views.single : views.tiles);

  /** Each camera's zoom that isn't its whole picture, to keep. */
  const keptOf = (shown: ReadonlyMap<string, View>) =>
    Object.fromEntries(
      [...shown].flatMap(([id, view]) =>
        view.level === 1 && view.pan.x === 0 && view.pan.y === 0
          ? []
          : [[id, { level: view.level, x: view.pan.x, y: view.pan.y }]],
      ),
    );

  const keepViews = () =>
    keep(storageKey, {
      views: keptOf(views.tiles),
      singleViews: keptOf(views.single),
    });

  const shown = () => section?.hidden === false;

  /** How many cameras there are, or were last time until they're known. */
  const count = () => (loaded ? streams.length : saved.count);

  /** How many cameras a page shows. */
  const size = () => (layout === "all" ? Math.max(count(), 1) : layout);

  const pages = () => Math.max(1, Math.ceil(count() / size()));

  /** Lays the grid out for a page's worth of cameras. */
  const arrangeGrid = (target: HTMLElement) => {
    const arrangement = gridFor(size());

    target.dataset.layout = arrangement.layout;

    const ratio =
      arrangement.columns === null || arrangement.rows === null
        ? null
        : `calc(${arrangement.columns * 16} / ${arrangement.rows * 9})`;

    for (const [name, value] of [
      ["--live-columns", arrangement.columns],
      ["--live-rows", arrangement.rows],
      ["--live-ratio", ratio],
    ] as const) {
      if (value === null) target.style.removeProperty(name);
      else target.style.setProperty(name, String(value));
    }
  };

  /**
   * Shimmering tiles in the shape the cameras will take, from how many there
   * were last time, so nothing moves when they arrive.
   */
  const placeholders = () => {
    if (grid === null) return;

    page = Math.min(page, pages() - 1);
    arrangeGrid(grid);
    grid.setAttribute("aria-busy", "true");

    const onPage = Math.max(1, Math.min(size(), count() - page * size()));

    grid.replaceChildren(
      ...Array.from({ length: onPage }, () => {
        const tile = element("div");

        tile.className = "live-tile";
        tile.dataset.loading = "";

        return tile;
      }),
    );
  };

  const setIcon = (
    button: HTMLElementTagNameMap["gw-button"] | null,
    icon: string,
    label?: string,
  ) => {
    // Pause and Play lead, larger and on a round filled button, as on the
    // Recordings page
    const main = button === playButton;

    button?.setAttribute("icon", icon);
    button?.setAttribute("labels", "hide");
    button?.setAttribute("appearance", main ? "accent" : "plain");
    button?.setAttribute("variant", main ? "brand" : "neutral");
    button?.setAttribute("size", main ? "large" : "medium");

    if (label !== undefined) button?.setAttribute("label", label);

    if (button !== null) {
      button.textContent = button.getAttribute("label") ?? "";
    }
  };

  setIcon(previousButton, phCaretLeft, "Previous cameras (Page Up)");
  setIcon(nextButton, phCaretRight, "Next cameras (Page Down)");
  setIcon(zoomOutButton, phMagnifyingGlassMinus, "Zoom out (−)");
  setIcon(zoomInButton, phMagnifyingGlassPlus, "Zoom in (+)");
  setIcon(captureButton, phCamera, "Save a still (S)");
  setIcon(helpButton, phQuestion, "Keyboard controls (?)");
  setIcon(fullscreenButton, phCornersOut, "Full screen (F)");
  previousButton?.setAttribute("aria-keyshortcuts", "PageUp");
  nextButton?.setAttribute("aria-keyshortcuts", "PageDown");
  zoomOutButton?.setAttribute("aria-keyshortcuts", "-");
  zoomFitButton?.setAttribute("aria-keyshortcuts", "0");
  zoomInButton?.setAttribute("aria-keyshortcuts", "+");
  fitToggle?.setAttribute("aria-keyshortcuts", "z");
  captureButton?.setAttribute("aria-keyshortcuts", "s");
  helpButton?.setAttribute("aria-keyshortcuts", "?");
  fullscreenButton?.setAttribute("aria-keyshortcuts", "f");
  playButton?.setAttribute("aria-keyshortcuts", "Space k");

  const keepPlace = () =>
    keep(storageKey, { layout, page, picked: picked ?? null });

  /** The controls for the cameras there are, and whether they're paused. */
  const showControls = () => {
    if (layoutToggle !== null) {
      // The last is every camera, so it shows how many that is
      layoutToggle.options = layoutsFor(count()).map((each) => ({
        value: String(each),
        label: each === "all" ? `${count()}/All` : String(each),
        hint: layoutHint(each),
      }));
      layoutToggle.value = String(layout);
    }

    const single = pages() <= 1;

    if (previousButton !== null) previousButton.disabled = single;

    if (nextButton !== null) nextButton.disabled = single;

    // Which page shows, when there's more than one, and the others to pick:
    // the cameras by name with one at a time, else each page's cameras
    if (pageSelect !== null) {
      pageSelect.hidden = single;
      pageSelect.label = size() === 1 ? "Camera" : "Page";
      pageSelect.options = Array.from({ length: pages() }, (_, index) => {
        const onPage = streams
          .slice(index * size(), index * size() + size())
          .map((stream) => cameraLabel(stream.id));

        return size() === 1
          ? {
              value: String(index),
              label: onPage[0] ?? `Camera ${index + 1}`,
              description: `${index + 1} of ${pages()}`,
            }
          : {
              value: String(index),
              label: `Page ${index + 1} of ${pages()}`,
              description: onPage.join(", "),
            };
      });
      pageSelect.value = String(page);
    }

    if (fitToggle !== null) {
      fitToggle.options = [
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
    }

    setIcon(
      playButton,
      paused ? phPlay : phPause,
      paused ? "Play (K)" : "Pause (K)",
    );

    if (playButton !== null) playButton.disabled = streams.length === 0;

    if (captureButton !== null) captureButton.disabled = tiles.length === 0;
  };

  const showPicked = () => {
    for (const tile of tiles) {
      const isPicked = tile.stream.id === picked;

      tile.figure.toggleAttribute("data-picked", isPicked);

      if (isPicked) tile.figure.setAttribute("aria-current", "true");
      else tile.figure.removeAttribute("aria-current");
    }

    showZoom();
  };

  /** Picks a camera on the page, which the zoom keys and buttons act on. */
  const pick = (id: Camera["id"]) => {
    picked = id;
    keepPlace();
    showPicked();
  };

  /** Clears the pick among several cameras, so none is marked out. */
  const unpick = () => {
    if (size() === 1 || picked === undefined) return;

    picked = undefined;
    keepPlace();
    showPicked();
  };

  const connect = (tile: Tile) => {
    if (tile.picture !== null) {
      tile.picture.src = stillAddress(tile.stream);

      return;
    }

    if (tile.player === null || tile.stream.live === null) return;

    // Its first frames end the shimmer, or the held frame after a pause.
    // Media events don't bubble, so the tile listens as they pass down
    tile.figure.addEventListener(
      "playing",
      () => {
        delete tile.figure.dataset.loading;
        tile.hold.removeAttribute("data-shown");
      },
      { capture: true, once: true },
    );

    tile.player.src = new URL(
      `${go2rtcPath}api/ws?src=${encodeURIComponent(streamFor(tile.stream.live, size()).name)}`,
      location.origin,
    ).href;
  };

  // A camera with only a still picture shows a new one every few seconds,
  // while the page shows and isn't paused
  setInterval(() => {
    if (paused || !shown()) return;

    for (const tile of tiles) {
      if (tile.picture !== null) connect(tile);
    }
  }, stillEvery);

  /** Puts the page's worth of cameras in the grid, and starts them unless paused. */
  const render = () => {
    if (grid === null || !shown()) return;

    page = Math.min(page, pages() - 1);
    arrangeGrid(grid);
    grid.removeAttribute("aria-busy");

    tiles = streams
      .slice(page * size(), page * size() + size())
      .map((stream) => {
        const figure = element("figure");
        const hold = element("canvas");

        const player =
          stream.live === null ? null : document.createElement("dvr-live");

        const picture = player === null ? element("img") : null;

        const ratio =
          stream.live === null ? null : streamFor(stream.live, size()).ratio;

        figure.className = "live-tile";
        figure.dataset.loading = "";
        hold.className = "live-hold";
        hold.setAttribute("aria-hidden", "true");

        // A squeezed stream's player takes the picture's own shape
        if (ratio !== null) {
          figure.dataset.squeezed = "";
          figure.style.setProperty("--tile-ratio", String(ratio));
        }

        if (player !== null) {
          player.mode = "mse,hls";
          // Video only: the recorder offers an audio track but sends nothing
          // on it, and a player waiting for that audio never starts
          player.media = "video";
          figure.append(player);
        }

        if (picture !== null) {
          picture.className = "live-still";
          // A drag moves the picture around, not a copy of it
          picture.draggable = false;
          picture.alt = "";
          picture.addEventListener("load", () => {
            delete figure.dataset.loading;
            showZoom();
          });
          figure.append(picture);
        }

        figure.append(hold, element("figcaption", cameraLabel(stream.id)));

        // Fill and the zoom's reach follow the picture's size, known once
        // its first frame does. Media events don't bubble, so the tile
        // listens as they pass down
        for (const type of ["loadedmetadata", "resize"]) {
          figure.addEventListener(type, () => showZoom(), { capture: true });
        }

        figure.addEventListener("click", () => pick(stream.id));

        figure.addEventListener("dblclick", () => {
          pick(stream.id);
          toggleSolo();
        });

        return { stream, figure, player, picture, hold, ratio };
      });

    // The pick stays on the page: one camera alone is always picked, and
    // among several a pick that's moved off the page is cleared
    if (!tiles.some((tile) => tile.stream.id === picked)) {
      picked = size() === 1 ? tiles[0]?.stream.id : undefined;
      keepPlace();
    }

    if (streams.length === 0) {
      grid.replaceChildren(element("p", "No cameras have a signal"));
      grid.firstElementChild?.classList.add("live-empty");
    } else {
      grid.replaceChildren(...tiles.map((tile) => tile.figure));
    }

    // On the page each player makes its video: the page's controls stand in
    // for the video's own
    for (const tile of tiles) {
      const video = tile.player?.querySelector("video") ?? null;

      if (video !== null) video.controls = false;

      if (!paused) connect(tile);
    }

    showPicked();
    showControls();
  };

  const setLayout = (next: Layout) => {
    // A count of every camera there is, by its digit, is All
    const wanted = next !== "all" && next >= count() ? "all" : next;

    if (wanted === layout || !layoutsFor(count()).includes(wanted)) return;

    // The first camera shown stays in view
    page = wanted === "all" ? 0 : Math.floor((page * size()) / wanted);
    layout = wanted;
    solo = undefined;
    keepPlace();
    render();
  };

  /** Shows a page, by its number from the first. */
  const goTo = (next: number) => {
    if (next === page || next < 0 || next >= pages()) return;

    page = next;
    keepPlace();
    render();
  };

  const step = (by: -1 | 1) => {
    if (pages() > 1) goTo((page + by + pages()) % pages());
  };

  /** Back from one camera alone to the layout it came from, at the page with the camera now picked. */
  const leaveSolo = () => {
    if (solo === undefined) return;

    const index = streams.findIndex((stream) => stream.id === picked);

    layout = solo.layout;
    page =
      index === -1 || layout === "all" ? solo.page : Math.floor(index / layout);
    solo = undefined;
    keepPlace();
    render();
  };

  /** The picked camera alone, or back to the layout it came from. */
  const toggleSolo = () => {
    if (solo !== undefined) {
      leaveSolo();

      return;
    }

    const index = streams.findIndex((stream) => stream.id === picked);
    const at = index === -1 ? page * size() : index;
    const camera = streams[at];

    if (camera === undefined) return;

    solo = { layout, page };
    picked = camera.id;
    layout = 1;
    page = at;
    keepPlace();
    render();
  };

  /**
   * Moves the pick to the nearest camera that way on the page; past the
   * left or right edge, onto the previous or next page.
   */
  const move = (key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => {
    const current = tiles.find((tile) => tile.stream.id === picked);

    if (current === undefined) {
      if (tiles[0] !== undefined) pick(tiles[0].stream.id);

      return;
    }

    const way = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    }[key];

    const middle = (tile: Tile) => {
      const box = tile.figure.getBoundingClientRect();

      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };

    const from = middle(current);

    // Ahead that way, and as little off to the side as can be
    const nearest = tiles
      .map((tile) => {
        const to = middle(tile);
        const ahead = (to.x - from.x) * way.x + (to.y - from.y) * way.y;

        const aside = Math.abs(
          (to.x - from.x) * way.y + (to.y - from.y) * way.x,
        );

        return { tile, ahead, score: ahead + aside * 2 };
      })
      .reduce<{ tile: Tile; score: number } | undefined>(
        (best, each) =>
          each.ahead > 1 && (best === undefined || each.score < best.score)
            ? each
            : best,
        undefined,
      );

    if (nearest !== undefined) {
      pick(nearest.tile.stream.id);

      return;
    }

    if (way.x === 0 || pages() <= 1) return;

    const next = (page + way.x + pages()) % pages();
    const onNext = streams.slice(next * size(), next * size() + size());
    const camera = way.x < 0 ? onNext.at(-1) : onNext[0];

    if (camera !== undefined) picked = camera.id;

    goTo(next);
  };

  const togglePause = () => {
    if (streams.length === 0) return;

    paused = !paused;

    for (const tile of tiles) {
      const video = tile.player?.querySelector("video") ?? null;

      // A still picture stays as it is while paused
      if (tile.player === null) {
        if (!paused) connect(tile);
      } else if (paused) {
        // The last frame stays up while the stream is closed
        if (video !== null && video.readyState >= 2) {
          const { width, height } = drawnSize(
            video.videoWidth,
            video.videoHeight,
            tile.ratio,
          );

          tile.hold.width = width;
          tile.hold.height = height;
          tile.hold.getContext("2d")?.drawImage(video, 0, 0, width, height);
          tile.hold.toggleAttribute("data-shown", true);
        }

        tile.player.ondisconnect();
      } else {
        connect(tile);
      }
    }

    showControls();
  };

  /** Saves a still of the picked camera, or the first shown. */
  const capture = () => {
    const tile =
      tiles.find((shownTile) => shownTile.stream.id === picked) ?? tiles[0];

    if (tile === undefined) return;

    const video = tile.player?.querySelector("video") ?? null;

    // Paused, the held frame is the picture; a camera with only a still
    // saves the one it shows
    const source =
      tile.picture ??
      (tile.hold.hasAttribute("data-shown") || video === null
        ? tile.hold
        : video);

    const size = sizeOf(source);

    // A squeezed stream's frame is saved at the picture's own shape
    const { width, height } =
      source instanceof HTMLVideoElement
        ? drawnSize(size.width, size.height, tile.ratio)
        : size;

    if (width === 0) return;

    const canvas = element("canvas");

    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (blob === null) return;

        const href = URL.createObjectURL(blob);
        const link = element("a");

        link.href = href;
        link.download = `${fileName(tile.stream.id)}_live_${fileTime()}.jpg`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
      },
      "image/jpeg",
      0.92,
    );
  };

  if (layoutToggle !== null) {
    on(layoutToggle, "change", () =>
      setLayout(
        layoutToggle.value === "all" ? "all" : Number(layoutToggle.value),
      ),
    );
  }

  previousButton?.addEventListener("click", () => step(-1));
  nextButton?.addEventListener("click", () => step(1));
  playButton?.addEventListener("click", togglePause);
  captureButton?.addEventListener("click", capture);

  fullscreenButton?.addEventListener("click", () => {
    if (document.fullscreenElement === null) {
      void stage?.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const full = document.fullscreenElement === stage;

    setIcon(
      fullscreenButton,
      full ? phCornersIn : phCornersOut,
      full ? "Exit full screen (F)" : "Full screen (F)",
    );
  });

  helpToggle(shortcutsPopover, helpButton);

  /**
   * Fills the picked camera's tile with its picture, or fits it whole, from
   * the middle. Every other camera keeps its own zoom.
   */
  const setFill = (next: boolean) => {
    const tile = zoomed();

    if (tile === undefined) return;

    viewsNow().set(tile.stream.id, {
      level: next ? "fill" : 1,
      pan: { x: 0, y: 0 },
    });
    keepViews();
    showZoom();
  };

  /**
   * Whether the picked camera covers its tile: filled, or zoomed in as far
   * or further. Whole, a picture the tile's own shape only fits it.
   */
  const filled = () => {
    const tile = zoomed();

    if (tile === undefined) return false;

    const { scale, fillScale } = placeOf(tile);
    const zoomedIn = viewOf(tile).level === "fill" || scale > 1 + zoomSlack;

    return zoomedIn && scale > fillScale - zoomSlack;
  };

  if (fitToggle !== null) {
    on(fitToggle, "change", () => setFill(fitToggle.value === "fill"));
  }

  if (pageSelect !== null) {
    on(pageSelect, "change", () => {
      goTo(Number(pageSelect.value));
      requestAnimationFrame(() => stage?.focus({ preventScroll: true }));
    });
  }

  // Zoom, each camera's its own and kept, once in tiles and once alone:
  // fitted whole, filling its tile,
  // or zoomed on from either, the picked camera by Z and in steps from the
  // buttons and keys, or the one under the pointer with Ctrl and the wheel
  // or a pinch. A picture bigger than its tile, filled or zoomed, moves
  // around by dragging, as on the Recordings page
  const zoomed = () => tiles.find((tile) => tile.stream.id === picked);

  const viewOf = (tile: Tile) => {
    const found = viewsNow().get(tile.stream.id);

    if (found !== undefined) return found;

    // Each picture starts whole
    const view: View = { level: 1, pan: { x: 0, y: 0 } };

    viewsNow().set(tile.stream.id, view);

    return view;
  };

  /**
   * Where a tile's picture sits: its tile, its scale from fitted whole, and
   * how far it reaches past the tile each way, as a share of the tile, so
   * how far it can move. Its reach is only known once its picture is.
   */
  const placeOf = (tile: Tile) => {
    const box = tile.figure.getBoundingClientRect();
    const source = tile.picture ?? tile.player?.querySelector("video") ?? null;
    const size = source === null ? { width: 0, height: 0 } : sizeOf(source);

    // A squeezed stream's frame is drawn at the picture's own shape
    const picture =
      source instanceof HTMLVideoElement
        ? drawnSize(size.width, size.height, tile.ratio)
        : size;

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

  const showZoom = () => {
    for (const tile of tiles) {
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

      for (const part of [tile.player, tile.picture, tile.hold]) {
        if (part !== null) part.style.transform = transform;
      }

      // Less than a pixel to move isn't worth a drag
      tile.figure.toggleAttribute(
        "data-movable",
        reachX * box.width >= 1 || reachY * box.height >= 1,
      );
    }

    const tile = zoomed();
    const scale = tile === undefined ? 1 : placeOf(tile).scale;

    if (fitToggle !== null) fitToggle.value = filled() ? "fill" : "fit";

    if (zoomFitButton !== null) {
      zoomFitButton.textContent = `${Math.round(scale * 100)}%`;
      zoomFitButton.disabled = scale <= 1;
    }

    if (zoomOutButton !== null) zoomOutButton.disabled = scale <= 1;

    if (zoomInButton !== null) {
      zoomInButton.disabled =
        tile === undefined || scale >= (pictureZooms.at(-1) ?? 1);
    }
  };

  /**
   * Zooms a picture to `next`, keeping the point at `at` (from its tile's
   * middle, as a share of it) where it is.
   */
  const zoomTo = (
    tile: Tile | undefined,
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
    showZoom();
    keepViews();
  };

  /**
   * Zooms a picture a step in or out from where it is. Filling its tile is
   * one of the steps, so Z and the zoom go through the same levels.
   */
  const zoomStep = (
    tile: Tile | undefined,
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

  zoomInButton?.addEventListener("click", () => zoomStep(zoomed(), 1));
  zoomOutButton?.addEventListener("click", () => zoomStep(zoomed(), -1));
  zoomFitButton?.addEventListener("click", () => zoomTo(zoomed(), 1));

  /** The tile a pointer event is on. */
  const tileAt = (event: Event) =>
    tiles.find((tile) => event.composedPath().includes(tile.figure));

  /** A pointer's place from the middle of a tile, as a share of it. */
  const fromMiddle = (event: MouseEvent, tile: Tile) => {
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

  grid?.addEventListener(
    "wheel",
    (event) => {
      const tile = tileAt(event);

      if (!event.ctrlKey || tile === undefined) return;

      event.preventDefault();
      pick(tile.stream.id);
      wheeled += event.deltaY;

      if (Math.abs(wheeled) < wheelStep) return;

      zoomStep(tile, wheeled < 0 ? 1 : -1, fromMiddle(event, tile));
      wheeled = 0;
    },
    { passive: false },
  );

  // A drag on a picture bigger than its tile moves it around, and picks it
  let drag:
    | { tile: Tile; x: number; y: number; pan: { x: number; y: number } }
    | undefined;

  grid?.addEventListener("pointerdown", (event) => {
    const tile = tileAt(event);

    if (tile === undefined || !tile.figure.hasAttribute("data-movable")) {
      return;
    }

    drag = { tile, x: event.clientX, y: event.clientY, pan: viewOf(tile).pan };
    pick(tile.stream.id);
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
    showZoom();
  });

  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, () => {
      if (drag === undefined) return;

      drag = undefined;
      keepViews();
    });
  }

  // The tiles' size changed, so how much Fill zooms and how far a picture
  // reaches did too
  window.addEventListener("resize", () => showZoom());

  const keys = new Map<string, () => void>([
    [" ", togglePause],
    ["k", togglePause],
    ["ArrowLeft", () => move("ArrowLeft")],
    ["ArrowRight", () => move("ArrowRight")],
    ["ArrowUp", () => move("ArrowUp")],
    ["ArrowDown", () => move("ArrowDown")],
    ["PageUp", () => step(-1)],
    ["PageDown", () => step(1)],
    ["Enter", toggleSolo],
    ["Escape", () => (solo === undefined ? unpick() : leaveSolo())],
    ["Backspace", leaveSolo],
    ["+", () => zoomStep(zoomed(), 1)],
    ["=", () => zoomStep(zoomed(), 1)],
    ["-", () => zoomStep(zoomed(), -1)],
    ["0", () => zoomTo(zoomed(), 1)],
    ["s", capture],
    ["z", () => setFill(!filled())],
    ["f", () => fullscreenButton?.click()],
    ["?", () => helpButton?.click()],
    // A digit key for each count up to 9, and A for All
    ...Array.from(
      { length: keyedLayouts },
      (_, index): [string, () => void] => [
        String(index + 1),
        () => setLayout(index + 1),
      ],
    ),
    ["a", () => setLayout("all")],
  ]);

  document.addEventListener("keydown", (event) => {
    if (!shown()) return;

    const key = controlKey(event);
    const action = keys.get(key ?? "");

    // Enter on a control presses it, as it should
    const onControl = event.target !== stage && event.target !== document.body;

    if (action === undefined || (key === "Enter" && onControl)) return;

    event.preventDefault();
    action();
  });

  // A click on a control hands the focus back to the cameras, so the keys
  // keep working; fields and the help keep it
  const focus = () => stage?.focus({ preventScroll: true });

  stage?.addEventListener("pointerup", (event) => {
    const path = event
      .composedPath()
      .filter((target) => target instanceof Element);

    if (path.some((target) => target.matches(`${typingTargets}, gw-popover`))) {
      return;
    }

    requestAnimationFrame(focus);
  });

  // A click on the space around the cameras clears the pick, as Esc does.
  // Where the press began counts, so a drag off a tile keeps it
  let pressedOnCamera = false;

  stage?.addEventListener("pointerdown", (event) => {
    pressedOnCamera = event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target.matches(".live-tile, .player-controls"),
      );
  });

  stage?.addEventListener("click", () => {
    if (!pressedOnCamera) unpick();
  });

  placeholders();
  showControls();

  return {
    show: async (cameras) => {
      await definePlayer(go2rtcPath);

      // Where the source can't tell whether there's a picture, it's tried;
      // a camera with only a still picture shows that
      streams = cameras.filter(
        (camera) =>
          (camera.live !== null || camera.still) && camera.signal !== false,
      );

      loaded = true;

      // A paged layout as big as the cameras there are now shows them all
      if (!layoutsFor(streams.length).includes(layout)) layout = "all";

      // Kept for next time's placeholders
      keep(storageKey, { count: streams.length });

      paused = false;
      render();
    },
    stop: () => {
      tiles = [];
      // Back to placeholders, so the page comes back without a jump
      placeholders();
    },
    focus,
  };
};
