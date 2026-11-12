/**
 * The Live page: every camera with a signal at once, or a layout's worth at a
 * time (1, 2, 3 or 4, and 6, 9 or 16 where there are more cameras), paged
 * with Previous and Next, under one set of controls: pause, fit or fill, a
 * still of the picked camera, full screen and keys. The layout, page, picked
 * camera, fit or fill and how many cameras there were are kept in this
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
  phPause,
  phPlay,
  phQuestion,
} from "./icons.ts";
import { controlKey, element, find, typingTargets } from "./shared.ts";

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

/** How many cameras each paged layout shows. */
const layouts = [1, 2, 3, 4, 6, 9, 16];

/** A layout: how many cameras at once, or all of them. */
type Layout = number | "all";

/**
 * The layouts worth offering for this many cameras: the paged ones that
 * show fewer than there are, then All, so five cameras offer 1 to 4 and All.
 */
const layoutsFor = (cameras: number): Array<Layout> => [
  ...layouts.filter((size) => size < cameras),
  "all",
];

/** A layout's tooltip. */
const layoutHint = (layout: Layout) => {
  if (layout === "all") return "Every camera at once";

  return layout === 1 ? "One camera" : `${layout} cameras at once`;
};

/**
 * The grid for `count` cameras at once: the smallest paged layout's grid
 * that holds them, else columns and rows as near square as they go.
 */
const gridFor = (count: number) => {
  const fits = layouts.find((size) => size >= count);

  if (fits !== undefined) {
    return { layout: String(fits), columns: null, rows: null };
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

/** What's kept, each part checked, since anyone can edit it. */
const kept = () => {
  const values = keptAt(storageKey);
  const layout = Number(values?.["layout"]);
  const page = Number(values?.["page"]);
  const count = Number(values?.["count"]);
  /** All until a paged one's picked, so every camera shows at first. */
  const keptLayout: Layout = layouts.includes(layout) ? layout : "all";

  return {
    layout: keptLayout,
    page: Number.isInteger(page) && page >= 0 ? page : 0,
    /** How many cameras there were last time, for the placeholders' shape. */
    count: Number.isInteger(count) && count > 0 ? count : 4,
    /** Whether the pictures fill their tiles, cropped, rather than fit. */
    fill: values?.["fill"] === true,
    // Kept before camera ids, the recorder's channel by number
    picked: Option.getOrUndefined(decodeSavedCamera(values?.["picked"])),
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
  const pageCount = find("span", "live-page-count");
  const fitToggle = find("gw-segmented", "live-fit");
  const captureButton = find("gw-button", "live-capture");
  const helpButton = find("gw-button", "live-help");
  const fullscreenButton = find("gw-button", "live-fullscreen");
  const shortcutsPopover = find("gw-popover", "live-shortcuts");
  const section = stage?.closest("section");

  const saved = kept();
  let layout: Layout = saved.layout;
  let page = saved.page;
  let picked = saved.picked;
  let fill = saved.fill;
  /** Where to go back to from one camera alone, by Enter or a double click. */
  let solo: { readonly layout: Layout; readonly page: number } | undefined;
  let paused = false;
  let streams: ReadonlyArray<Camera> = [];
  let tiles: ReadonlyArray<Tile> = [];
  /** Whether the cameras are known, rather than guessed from last time. */
  let loaded = false;

  const shown = () => section?.hidden === false;

  /** How many cameras there are, or were last time until they're known. */
  const count = () => (loaded ? streams.length : saved.count);

  /** How many cameras a page shows. */
  const size = () => (layout === "all" ? Math.max(count(), 1) : layout);

  const pages = () => Math.max(1, Math.ceil(count() / size()));

  /** Lays the grid out for a page's worth of cameras. */
  const arrangeGrid = (target: HTMLElement) => {
    const arrangement =
      layout === "all"
        ? gridFor(size())
        : { layout: String(layout), columns: null, rows: null };

    target.dataset.layout = arrangement.layout;
    target.toggleAttribute("data-fill", fill);

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

  setIcon(previousButton, phCaretLeft, "Previous cameras (←)");
  setIcon(nextButton, phCaretRight, "Next cameras (→)");
  setIcon(captureButton, phCamera, "Save a still (S)");
  setIcon(helpButton, phQuestion, "Keyboard controls (?)");
  setIcon(fullscreenButton, phCornersOut, "Full screen (F)");
  previousButton?.setAttribute("aria-keyshortcuts", "ArrowLeft");
  nextButton?.setAttribute("aria-keyshortcuts", "ArrowRight");
  fitToggle?.setAttribute("aria-keyshortcuts", "z");
  captureButton?.setAttribute("aria-keyshortcuts", "s");
  helpButton?.setAttribute("aria-keyshortcuts", "?");
  fullscreenButton?.setAttribute("aria-keyshortcuts", "f");
  playButton?.setAttribute("aria-keyshortcuts", "Space k");

  const keepPlace = () =>
    keep(storageKey, { layout, page, picked: picked ?? null, fill });

  /** The controls for the cameras there are, and whether they're paused. */
  const showControls = () => {
    if (layoutToggle !== null) {
      layoutToggle.options = layoutsFor(count()).map((each) => ({
        value: String(each),
        label: each === "all" ? "All" : String(each),
        hint: layoutHint(each),
      }));
      layoutToggle.value = String(layout);
    }

    const single = pages() <= 1;

    if (previousButton !== null) previousButton.disabled = single;

    if (nextButton !== null) nextButton.disabled = single;

    // Which page shows, when there's more than one
    if (pageCount !== null) {
      pageCount.hidden = single;
      pageCount.textContent = `${page + 1} of ${pages()}`;
      pageCount.title = `Page ${page + 1} of ${pages()}`;
    }

    if (fitToggle !== null) {
      fitToggle.options = [
        {
          value: "fit",
          label: "Fit",
          icon: phArrowsInSimple,
          hint: "Fit: whole pictures (Z)",
        },
        {
          value: "fill",
          label: "Fill",
          icon: phArrowsOutSimple,
          hint: "Fill: pictures zoomed to their tiles (Z)",
        },
      ];
      fitToggle.value = fill ? "fill" : "fit";
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
      tile.figure.toggleAttribute("data-picked", tile.stream.id === picked);
    }
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
          picture.alt = "";
          picture.addEventListener("load", () => {
            delete figure.dataset.loading;
          });
          figure.append(picture);
        }

        figure.append(hold, element("figcaption", cameraLabel(stream.id)));

        figure.addEventListener("click", () => {
          picked = stream.id;
          keepPlace();
          showPicked();
        });

        figure.addEventListener("dblclick", () => {
          picked = stream.id;
          toggleSolo();
        });

        return { stream, figure, player, picture, hold, ratio };
      });

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
    if (next === layout || !layoutsFor(count()).includes(next)) return;

    // The first camera shown stays in view
    page = next === "all" ? 0 : Math.floor((page * size()) / next);
    layout = next;
    solo = undefined;
    keepPlace();
    render();
  };

  const step = (by: -1 | 1) => {
    if (pages() <= 1) return;

    page = (page + by + pages()) % pages();
    solo = undefined;
    keepPlace();
    render();
  };

  /** The picked camera alone, or back to the layout it came from. */
  const toggleSolo = () => {
    if (solo !== undefined) {
      ({ layout, page } = solo);
      solo = undefined;
    } else {
      const index = streams.findIndex((stream) => stream.id === picked);
      const at = index === -1 ? page * size() : index;
      const camera = streams[at];

      if (camera === undefined) return;

      solo = { layout, page };
      picked = camera.id;
      layout = 1;
      page = at;
    }

    keepPlace();
    render();
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

  helpButton?.addEventListener("click", () =>
    shortcutsPopover?.show(helpButton),
  );

  /** Fit whole pictures, or fill the tiles with them. */
  const setFill = (next: boolean) => {
    fill = next;
    grid?.toggleAttribute("data-fill", fill);
    keepPlace();
    showControls();
  };

  if (fitToggle !== null) {
    on(fitToggle, "change", () => setFill(fitToggle.value === "fill"));
  }

  const keys = new Map<string, () => void>([
    [" ", togglePause],
    ["k", togglePause],
    ["ArrowLeft", () => step(-1)],
    ["ArrowRight", () => step(1)],
    ["Enter", toggleSolo],
    ["s", capture],
    ["z", () => setFill(!fill)],
    ["f", () => fullscreenButton?.click()],
    ["?", () => helpButton?.click()],
    // A digit key for each layout up to 9, and A for All
    ...layouts.flatMap((each): Array<[string, () => void]> =>
      each < 10 ? [[String(each), () => setLayout(each)]] : [],
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
