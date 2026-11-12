/**
 * The Live page: the cameras with a signal, a layout's worth at a time (1, 2,
 * 3 or 4, and 6, 9 or 16 where there are more cameras), paged with Previous
 * and Next, under one set of controls: pause, a still of the picked camera,
 * full screen and keys. The layout, page and picked camera are kept in this
 * browser. The players only run while the page shows, so a hidden page
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

/** How many cameras each layout shows. */
const layouts = [1, 2, 3, 4, 6, 9, 16];

/**
 * The layouts worth offering for this many cameras: the ones they fill, and
 * the first that shows them all, so a four-camera recorder offers 1 to 4.
 */
const layoutsFor = (cameras: number) => {
  const all = layouts.find((size) => size >= cameras) ?? 16;

  return layouts.filter((size) => size <= cameras || size === all);
};

/**
 * Past four at once, the small sub stream where there is one: the main one
 * is more than a small tile shows.
 */
const streamFor = (live: LiveStreams, layout: number) =>
  layout > 4 ? (live.sub ?? live.main) : live.main;

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

  return {
    layout: layouts.includes(layout) ? layout : 4,
    page: Number.isInteger(page) && page >= 0 ? page : 0,
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
  const captureButton = find("gw-button", "live-capture");
  const helpButton = find("gw-button", "live-help");
  const fullscreenButton = find("gw-button", "live-fullscreen");
  const shortcutsPopover = find("gw-popover", "live-shortcuts");
  const section = stage?.closest("section");

  const saved = kept();
  let layout = saved.layout;
  let page = saved.page;
  let picked = saved.picked;
  /** Where to go back to from one camera alone, by Enter or a double click. */
  let solo: { readonly layout: number; readonly page: number } | undefined;
  let paused = false;
  let streams: ReadonlyArray<Camera> = [];
  let tiles: ReadonlyArray<Tile> = [];

  // The placeholders take the kept layout's shape from the first paint
  if (grid !== null) grid.dataset.layout = String(layout);

  const shown = () => section?.hidden === false;

  const pages = () => Math.max(1, Math.ceil(streams.length / layout));

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
  setIcon(helpButton, phQuestion);
  setIcon(fullscreenButton, phCornersOut, "Full screen (F)");
  previousButton?.setAttribute("aria-keyshortcuts", "ArrowLeft");
  nextButton?.setAttribute("aria-keyshortcuts", "ArrowRight");
  captureButton?.setAttribute("aria-keyshortcuts", "s");
  fullscreenButton?.setAttribute("aria-keyshortcuts", "f");
  playButton?.setAttribute("aria-keyshortcuts", "Space k");

  const keepPlace = () =>
    keep(storageKey, { layout, page, picked: picked ?? null });

  /** The controls for the cameras there are, and whether they're paused. */
  const showControls = () => {
    if (layoutToggle !== null) {
      layoutToggle.options = layoutsFor(streams.length).map((size) => ({
        value: String(size),
        label: String(size),
        hint: size === 1 ? "One camera" : `${size} cameras at once`,
      }));
      layoutToggle.value = String(layout);
    }

    const single = pages() <= 1;

    if (previousButton !== null) previousButton.disabled = single;

    if (nextButton !== null) nextButton.disabled = single;

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
      `${go2rtcPath}api/ws?src=${encodeURIComponent(streamFor(tile.stream.live, layout))}`,
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
    grid.dataset.layout = String(layout);
    // The sub stream's pictures are squeezed, which the styles undo
    grid.dataset.stream = layout > 4 ? "sub" : "main";
    grid.removeAttribute("aria-busy");

    tiles = streams
      .slice(page * layout, page * layout + layout)
      .map((stream) => {
        const figure = element("figure");
        const hold = element("canvas");

        const player =
          stream.live === null ? null : document.createElement("dvr-live");

        const picture = player === null ? element("img") : null;

        figure.className = "live-tile";
        figure.dataset.loading = "";
        hold.className = "live-hold";
        hold.setAttribute("aria-hidden", "true");

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

        return { stream, figure, player, picture, hold };
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

  const setLayout = (size: number) => {
    if (size === layout || !layoutsFor(streams.length).includes(size)) return;

    // The first camera shown stays in view
    page = Math.floor((page * layout) / size);
    layout = size;
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
      const at = index === -1 ? page * layout : index;
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
          tile.hold.width = video.videoWidth;
          tile.hold.height = video.videoHeight;
          tile.hold.getContext("2d")?.drawImage(video, 0, 0);
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

    const { width, height } = sizeOf(source);

    if (width === 0) return;

    const canvas = element("canvas");

    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(source, 0, 0);
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
    on(layoutToggle, "change", () => setLayout(Number(layoutToggle.value)));
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

  const keys = new Map<string, () => void>([
    [" ", togglePause],
    ["k", togglePause],
    ["ArrowLeft", () => step(-1)],
    ["ArrowRight", () => step(1)],
    ["Enter", toggleSolo],
    ["s", capture],
    ["f", () => fullscreenButton?.click()],
    // A digit key for each layout up to 9
    ...layouts.flatMap((size): Array<[string, () => void]> =>
      size < 10 ? [[String(size), () => setLayout(size)]] : [],
    ),
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

      // A layout bigger than there are cameras for falls back to the one
      // that shows them all
      if (!layoutsFor(streams.length).includes(layout)) {
        layout = layoutsFor(streams.length).at(-1) ?? 1;
      }

      paused = false;
      render();
    },
    stop: () => {
      grid?.replaceChildren();
      tiles = [];
    },
    focus,
  };
};
