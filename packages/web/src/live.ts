/**
 * The Live page: every camera with a signal at once, or a layout's worth at a
 * time (any count from one to one fewer than there are), paged with
 * Previous and Next or picked from the page list, under one set of controls:
 * pause, zoom (fit, fill or a step at a time, each camera its own), a still
 * of the picked camera, full screen and keys. Smart tiling sizes the tiles
 * to the window so they fill as much of it as they can; the View menu swaps
 * it for each count's fixed layout. The arrow keys move the pick,
 * on to the next page past the edge. A camera that moves is steered in Move
 * mode, and one with picture settings has its hue, brightness and the rest
 * on sliders in the Picture panel. One with a second view, such as a
 * telephoto lens, plays both,
 * the other small in a corner, and swaps them without reloading either. The
 * picked camera's sound plays where it has a microphone and its sound is on,
 * each camera with its own volume. The layout, tiling, page, picked camera, each
 * camera's view, zoom and sound and how many cameras there were are kept in
 * this browser, so the placeholders take the cameras' places before they're
 * known. A camera whose source can't be reached says why over its tile. The
 * players only run while the page shows, so a hidden page streams nothing.
 */
import type { Camera, CameraView, LiveStreams } from "@timmo001/kestrel-core";
import { go2rtcPath } from "@timmo001/kestrel-server/api";
import { on } from "@timmo001/groundwork-ui";
import { keep, keptAt } from "@timmo001/groundwork-ui/kept.ts";
import { Option, Schema } from "effect";
import { SavedCamera } from "./addresses.ts";
import { serverUrl } from "./api.ts";
import { cameraLabel, fileName } from "./cameras.ts";
import {
  phCamera,
  phCaretLeft,
  phCaretRight,
  phCornersIn,
  phCornersOut,
  phJoystick,
  phMagnifyingGlassMinus,
  phMagnifyingGlassPlus,
  phPause,
  phPlay,
  phQuestion,
  phSlidersHorizontal,
  phSpeakerHigh,
  phSpeakerLow,
  phSpeakerSlash,
  phSquaresFour,
} from "./icons.ts";
import { pictureSettings, type PictureTile } from "./picture.ts";
import { steering, type SteerTile } from "./ptz.ts";
import {
  controlKey,
  element,
  find,
  helpToggle,
  typingTargets,
} from "./shared.ts";
import {
  applyTiling,
  clearTiling,
  tilingFor,
  tilingModes as tilings,
  type TilingMode as Tiling,
} from "./tiling.ts";
import { pictureZoom, type PictureView, type ZoomTile } from "./zoom.ts";

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
 * An address under go2rtc, from its root-relative `path`, such as
 * `/go2rtc/api/ws`, kept under the path the page is served from.
 */
const go2rtcUrl = (path: string) => serverUrl(path.replace(/^\//, ""));

/**
 * Defines `dvr-live` from go2rtc's own `video-rtc.js`, served beside it, so
 * the player always matches the go2rtc that sends the stream.
 */
const definePlayer = async (path: string) => {
  if (customElements.get("dvr-live") !== undefined) return;

  const url = go2rtcUrl(`${path}video-rtc.js`).href;

  const { VideoRTC }: VideoRtcModule = await import(url);

  if (customElements.get("dvr-live") === undefined) {
    customElements.define("dvr-live", VideoRTC);
  }
};

/** Whether a camera, or one of its views, carries its sound. */
const hasSound = (camera: Camera) =>
  camera.live?.sound === true || camera.views.some((view) => view.live.sound);

/** A player for one of a camera's views, or its only one. */
const livePlayer = (camera: Camera, view: CameraView | undefined) => {
  const player = document.createElement("dvr-live");

  player.mode = "mse,hls";
  // Sound only where the camera sends it: the recorder offers a sound track
  // but sends nothing on it, and a player waiting for that never starts
  player.media =
    (view?.live ?? camera.live)?.sound === true ? "video,audio" : "video";

  if (view !== undefined) player.dataset["view"] = view.key;

  return player;
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

/**
 * How many slow streams, such as a web page's, start at once: more at once
 * only slow each other down, so the first cameras show sooner this way.
 */
const slowStarts = 2;

/** How long a slow stream has to start before the next goes ahead anyway. */
const slowStartWait = 30_000;

/** A camera's still picture now; the time makes each one new to the browser. */
const stillAddress = (camera: Camera) =>
  serverUrl(`api/cameras/${camera.id}/still?at=${Date.now()}`).href;

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

/** Each camera's view picked, such as `telephoto`, by its id. */
const decodeKeptLenses = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.String),
);

/** Each camera's sound, by its id: whether it's on and how loud, from 0 to 100. */
const KeptSounds = Schema.Record(
  Schema.String,
  Schema.Struct({
    on: Schema.Boolean,
    volume: Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  }),
);

const decodeKeptSounds = Schema.decodeUnknownOption(KeptSounds);

/** A camera's sound until it's changed: off, at full volume. */
const quiet = { on: false, volume: 100 };

/** What's kept, each part checked, since anyone can edit it. */
const kept = () => {
  const values = keptAt(storageKey);
  const layout = Number(values?.["layout"]);
  const page = Number(values?.["page"]);
  const count = Number(values?.["count"]);

  /** All until a paged one's picked, so every camera shows at first. */
  const keptLayout: Layout =
    Number.isInteger(layout) && layout >= 1 ? layout : "all";

  /** Smart until fixed layouts are picked. */
  const keptTiling: Tiling = values?.["tiling"] === "fixed" ? "fixed" : "smart";

  return {
    layout: keptLayout,
    tiling: keptTiling,
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
    /** Each camera's view picked, for a camera with more than one. */
    lenses: Option.getOrElse(decodeKeptLenses(values?.["lenses"]), () => ({})),
    /** Each camera's sound, for a camera with a microphone. */
    sounds: Option.getOrElse(decodeKeptSounds(values?.["sounds"]), () => ({})),
  };
};

/**
 * A camera on the page: its tile, its player or still picture, and held
 * frame. A camera with two views, such as a TrackMix's lenses, plays both
 * at once, the other small in a corner, and they swap places.
 */
interface Tile {
  readonly stream: Camera;
  readonly figure: HTMLElement;
  /** Its player for the view it shows, for a camera that plays live. */
  player: LivePlayer | null;
  /** Its other view's player, small in a corner. */
  inset: LivePlayer | null;
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
  /** Shows why a source's cameras can't be seen over their tiles, by source id; those left out are cleared. */
  readonly showProblems: (
    problems: ReadonlyMap<Camera["source"], string>,
  ) => void;
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
  const layoutMore = find("gw-menu-button", "live-layout-more");
  const viewMenu = find("gw-menu-button", "live-view");
  const previousButton = find("gw-button", "live-previous");
  const playButton = find("gw-button", "live-play");
  const nextButton = find("gw-button", "live-next");
  const pageSelect = find("gw-select", "live-page");
  const zoomOutButton = find("gw-button", "live-zoom-out");
  const zoomFitButton = find("gw-button", "live-zoom-fit");
  const zoomInButton = find("gw-button", "live-zoom-in");
  const fitToggle = find("gw-segmented", "live-fit");
  const captureButton = find("gw-button", "live-capture");
  const moveButton = find("gw-button", "live-move");
  const pictureButton = find("gw-button", "live-picture");
  const soundButton = find("gw-button", "live-sound");
  const soundDivider = find("span", "live-sound-divider");
  const volumeRange = find("gw-range", "live-volume");
  const helpButton = find("gw-button", "live-help");
  const fullscreenButton = find("gw-button", "live-fullscreen");
  const shortcutsPopover = find("gw-popover", "live-shortcuts");
  const section = stage?.closest("section");

  const saved = kept();
  let layout: Layout = saved.layout;
  let tiling: Tiling = saved.tiling;
  let page = saved.page;
  // Several cameras start with none picked, so none is marked out
  let picked = saved.layout === 1 ? saved.picked : undefined;
  /** Where to go back to from one camera alone, by Enter or a double click. */
  let solo: { readonly layout: Layout; readonly page: number } | undefined;
  let paused = false;
  let streams: ReadonlyArray<Camera> = [];
  let tiles: ReadonlyArray<Tile> = [];
  /** Why each source's cameras can't be seen, by source id. */
  let problems: ReadonlyMap<Camera["source"], string> = new Map();
  /** Whether the cameras are known, rather than guessed from last time. */
  let loaded = false;

  /** Each camera's sound, by camera id, kept from last time. */
  const sounds = new Map<string, { on: boolean; volume: number }>(
    Object.entries(saved.sounds),
  );

  /**
   * Whether the browser held the sound back, as it does until the page has
   * had a click or a key; the next one lets it play.
   */
  let soundHeld = false;

  /** Set below: shows each picture at its zoom, and the controls to match. */
  let showZoom: () => void = () => undefined;

  /** Each camera's zoom from a views kept, by camera id. */
  const viewsFrom = (kept: typeof saved.views) =>
    new Map<string, PictureView>(
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
  const keptOf = (shown: ReadonlyMap<string, PictureView>) =>
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

  /** Each camera's view picked, by camera id, kept from last time. */
  const lenses = new Map<string, string>(Object.entries(saved.lenses));

  /** The view a camera shows, for one with more than one: the one picked, else its main one. */
  const viewOf = (camera: Camera): CameraView | undefined =>
    camera.views.find((view) => view.key === lenses.get(camera.id)) ??
    camera.views[0];

  /** The streams a camera plays now, from the view it shows. */
  const liveOf = (camera: Camera) => viewOf(camera)?.live ?? camera.live;

  /** The shape to draw a tile's video at, for a squeezed sub stream; else `null`. */
  const ratioOf = (tile: Tile) => {
    const live = liveOf(tile.stream);

    return live === null ? null : streamFor(live, size()).ratio;
  };

  /** A squeezed stream's player takes the picture's own shape. */
  const squeezeTile = (tile: Tile) => {
    const ratio = ratioOf(tile);

    tile.figure.toggleAttribute("data-squeezed", ratio !== null);

    if (ratio === null) tile.figure.style.removeProperty("--tile-ratio");
    else tile.figure.style.setProperty("--tile-ratio", String(ratio));
  };

  const shown = () => section?.hidden === false;

  /** How many cameras there are, or were last time until they're known. */
  const count = () => (loaded ? streams.length : saved.count);

  /** How many cameras a page shows. */
  const size = () => (layout === "all" ? Math.max(count(), 1) : layout);

  const pages = () => Math.max(1, Math.ceil(count() / size()));

  /**
   * Lays the grid out for the cameras in it. Smart tiling sizes them to the
   * space around the grid, every camera on the page filling as much of it
   * as they can; fixed layouts keep the page's own shape, however many are
   * on it.
   */
  const arrangeGrid = (target: HTMLElement) => {
    stage?.setAttribute("data-tiling", tiling);

    const smart = tiling === "smart";
    const arrangement = smart ? undefined : gridFor(size());

    target.dataset.layout = arrangement?.layout ?? "smart";

    const columns = arrangement?.columns ?? null;
    const rows = arrangement?.rows ?? null;

    const ratio =
      columns === null || rows === null
        ? null
        : `calc(${columns * 16} / ${rows * 9})`;

    for (const [name, value] of [
      ["--live-columns", columns],
      ["--live-rows", rows],
      ["--live-ratio", ratio],
    ] as const) {
      if (value === null) target.style.removeProperty(name);
      else target.style.setProperty(name, String(value));
    }

    if (!smart) {
      clearTiling(target);

      return;
    }

    const area = target.parentElement;

    // Hidden, the space measures nothing, so the last tiling stays until
    // it shows again
    const tiled =
      area === null
        ? undefined
        : tilingFor(
            Math.max(target.childElementCount, 1),
            area.clientWidth,
            area.clientHeight,
          );

    if (tiled !== undefined) applyTiling(target, tiled);
  };

  /**
   * Shimmering tiles in the shape the cameras will take, from how many there
   * were last time, so nothing moves when they arrive.
   */
  const placeholders = () => {
    if (grid === null) return;

    page = Math.min(page, pages() - 1);
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

    arrangeGrid(grid);
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
  setIcon(moveButton, phJoystick, "Move the camera (M)");
  setIcon(pictureButton, phSlidersHorizontal, "Picture settings (P)");
  setIcon(soundButton, phSpeakerSlash, "Unmute (U)");
  setIcon(helpButton, phQuestion, "Keyboard controls (?)");
  setIcon(fullscreenButton, phCornersOut, "Full screen (F)");
  previousButton?.setAttribute("aria-keyshortcuts", "PageUp");
  nextButton?.setAttribute("aria-keyshortcuts", "PageDown");
  zoomOutButton?.setAttribute("aria-keyshortcuts", "-");
  zoomFitButton?.setAttribute("aria-keyshortcuts", "0");
  zoomInButton?.setAttribute("aria-keyshortcuts", "+");
  captureButton?.setAttribute("aria-keyshortcuts", "s");
  moveButton?.setAttribute("aria-keyshortcuts", "m");
  moveButton?.toggleAttribute("toggle", true);
  pictureButton?.setAttribute("aria-keyshortcuts", "p");
  pictureButton?.toggleAttribute("toggle", true);
  soundButton?.setAttribute("aria-keyshortcuts", "u");
  helpButton?.setAttribute("aria-keyshortcuts", "?");
  fullscreenButton?.setAttribute("aria-keyshortcuts", "f");
  playButton?.setAttribute("aria-keyshortcuts", "Space k");

  const keepPlace = () =>
    keep(storageKey, { layout, page, picked: picked ?? null });

  /** The picked camera's tile, as steering sees it, for a camera that moves. */
  const steerTile = (): SteerTile | undefined => {
    const tile = tiles.find((shownTile) => shownTile.stream.id === picked);
    const controls = tile?.stream.controls.ptz ?? null;

    if (tile === undefined || controls === null) return undefined;

    return {
      id: tile.stream.id,
      figure: tile.figure,
      controls,
      lensZoom: viewOf(tile.stream)?.zoom ?? true,
    };
  };

  /** Move, shown where any camera moves and pressed while it's on. */
  const showMove = () => {
    if (moveButton === null) return;

    moveButton.hidden = !streams.some((stream) => stream.controls.ptz !== null);
    moveButton.disabled = steerTile() === undefined;
    moveButton.pressed = steer.on();
  };

  /** The picked camera, for one with picture settings. */
  const pictureTile = (): PictureTile | undefined => {
    const tile = tiles.find((shownTile) => shownTile.stream.id === picked);
    const controls = tile?.stream.controls.picture ?? null;

    return tile === undefined || controls === null
      ? undefined
      : { id: tile.stream.id, controls };
  };

  /** Picture settings, shown where any camera has them and pressed while open. */
  const showPicture = () => {
    if (pictureButton === null) return;

    pictureButton.hidden = !streams.some(
      (stream) => stream.controls.picture !== null,
    );
    pictureButton.disabled = pictureTile() === undefined;
    pictureButton.pressed = picture.open();
  };

  /** The picked camera's tile, for a camera with sound. */
  const soundTile = () =>
    tiles.find((tile) => tile.stream.id === picked && hasSound(tile.stream));

  /** A camera's sound, as kept, or off at full volume, its volume in the slider's 5% steps. */
  const soundOf = (camera: Camera) => {
    const sound = sounds.get(camera.id) ?? quiet;

    return { ...sound, volume: Math.round(sound.volume / 5) * 5 };
  };

  const setSound = (camera: Camera, sound: { on: boolean; volume: number }) => {
    sounds.set(camera.id, sound);
    keep(storageKey, { sounds: Object.fromEntries(sounds) });
    showSound();
  };

  /**
   * Plays the picked camera's sound alone, where it's on, from the view it
   * shows big, at its own volume, and keeps every other player quiet. Sound
   * and its volume show where any camera has sound.
   */
  const showSound = () => {
    const tile = soundTile();
    const sound = tile === undefined ? quiet : soundOf(tile.stream);
    const heard = sound.on && !soundHeld ? tile : undefined;

    for (const each of tiles) {
      for (const player of [each.player, each.inset]) {
        const video = player?.querySelector("video") ?? null;

        if (video === null) continue;

        video.volume = soundOf(each.stream).volume / 100;
        video.muted = each !== heard || player !== each.player;
      }
    }

    const any = streams.some(hasSound);

    // The icon shows whether it's on, so the button stays plain, named for
    // what a press does
    setIcon(
      soundButton,
      !sound.on || sound.volume === 0
        ? phSpeakerSlash
        : sound.volume < 50
          ? phSpeakerLow
          : phSpeakerHigh,
      sound.on ? "Mute (U)" : "Unmute (U)",
    );

    if (soundDivider !== null) soundDivider.hidden = !any;

    if (soundButton !== null) {
      soundButton.hidden = !any;
      soundButton.disabled = tile === undefined;
    }

    if (volumeRange !== null) {
      volumeRange.hidden = !any;
      volumeRange.disabled = tile === undefined;
      volumeRange.value = sound.volume;
    }
  };

  const toggleSound = () => {
    const tile = soundTile();

    if (tile === undefined) return;

    const sound = soundOf(tile.stream);

    // Sound that's on but held back by the browser plays, rather than going off
    if (soundHeld && sound.on) {
      soundHeld = false;
      showSound();

      return;
    }

    setSound(tile.stream, { ...sound, on: !sound.on });
  };

  // Sound held back until the page had a click or a key plays after the
  // next, once the Sound button has seen it
  const release = () => {
    if (!soundHeld) return;

    soundHeld = false;
    showSound();
  };

  document.addEventListener("click", release);
  document.addEventListener("keyup", release);

  const steer = steering({
    area: grid,
    picked: steerTile,
    onChange: () => {
      showMove();
      showZoom();
    },
  });

  /** Move mode on the picked camera, where it moves, or off. */
  const toggleMove = () => {
    if (steer.on() || steerTile() !== undefined) steer.toggle();
  };

  moveButton?.addEventListener("click", toggleMove);

  const picture = pictureSettings({
    button: pictureButton,
    picked: pictureTile,
    onChange: showPicture,
  });

  soundButton?.addEventListener("click", toggleSound);

  // Turning it up plays the sound, as it would on a speaker
  volumeRange?.addEventListener("input", () => {
    const tile = soundTile();

    if (tile === undefined) return;

    const volume = volumeRange.value;

    setSound(tile.stream, {
      on: volume > 0 || soundOf(tile.stream).on,
      volume,
    });
  });

  /** The controls for the cameras there are, and whether they're paused. */
  const showControls = () => {
    const layouts = layoutsFor(count());

    // Counts up to what a digit key picks sit in the row, with All; the
    // rest go in a menu beside it, so the row stays short
    const keyed = layouts.filter(
      (each) => each === "all" || each <= keyedLayouts,
    );

    const more = layouts.filter(
      (each): each is number => each !== "all" && each > keyedLayouts,
    );

    if (layoutToggle !== null) {
      // The last is every camera, so it shows how many that is
      layoutToggle.options = keyed.map((each) => ({
        value: String(each),
        label: each === "all" ? `${count()}/All` : String(each),
        hint: layoutHint(each),
      }));
      layoutToggle.value = keyed.includes(layout) ? String(layout) : "";
    }

    if (layoutMore !== null) {
      const isMore = layout !== "all" && layout > keyedLayouts;

      layoutMore.hidden = more.length === 0;
      layoutMore.label = isMore ? String(layout) : `${keyedLayouts + 1}+`;
      layoutMore.active = isMore;
      layoutMore.items = more.map((each) => ({
        value: String(each),
        label: String(each),
        description: layoutHint(each),
        checked: each === layout,
      }));
    }

    if (viewMenu !== null) {
      viewMenu.items = tilings.map((each) => ({
        ...each,
        group: "Tiling",
        checked: each.value === tiling,
      }));
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

    // Move mode follows the camera, and ends once another's picked
    steer.show();
    showMove();
    picture.show();
    showPicture();
    showZoom();
    showSound();
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

    for (const player of [tile.player, tile.inset]) {
      if (player === null) continue;

      if (liveOfPlayer(tile, player)?.slowStart === true) {
        waiting.push({ tile, player });
      } else {
        connectPlayer(tile, player);
      }
    }

    startWaiting();
  };

  /** Slow players still to start, in the cameras' order. */
  let waiting: Array<{ readonly tile: Tile; readonly player: LivePlayer }> = [];

  /** Slow players started that haven't played yet, each with its start. */
  const starting = new Map<LivePlayer, object>();

  /** Starts slow players while fewer than `slowStarts` are still starting. */
  const startWaiting = () => {
    while (starting.size < slowStarts) {
      const next = waiting.shift();

      if (next === undefined) return;

      // Gone with a new page or layout
      if (!next.player.isConnected) continue;

      const { player } = next;
      const start = {};

      // Only this start's end counts, not one from before a pause
      const started = () => {
        if (starting.get(player) !== start) return;

        starting.delete(player);
        startWaiting();
      };

      starting.set(player, start);
      player.addEventListener("playing", started, {
        capture: true,
        once: true,
      });
      setTimeout(started, slowStartWait);
      connectPlayer(next.tile, player);
    }
  };

  /** Drops the slow players still to start or starting, as the page changes or pauses. */
  const stopWaiting = () => {
    waiting = [];
    starting.clear();
  };

  /** The streams one of a tile's players plays, from its view. */
  const liveOfPlayer = (tile: Tile, player: LivePlayer) =>
    tile.stream.views.find((view) => view.key === player.dataset["view"])
      ?.live ?? tile.stream.live;

  const connectPlayer = (tile: Tile, player: LivePlayer) => {
    const live = liveOfPlayer(tile, player);

    if (live === null) return;

    player.toggleAttribute("data-loading", true);

    // Its first frames end its shimmer, and the tile's, or the held frame
    // after a pause, while it's the one shown. Media events don't bubble, so
    // the player listens as they pass down
    player.addEventListener(
      "playing",
      () => {
        player.removeAttribute("data-loading");
        held.delete(player);

        if (player === tile.player) {
          delete tile.figure.dataset.loading;
          tile.hold.removeAttribute("data-shown");
        }
      },
      { capture: true, once: true },
    );

    player.src = go2rtcUrl(
      `${go2rtcPath}api/ws?src=${encodeURIComponent(streamFor(live, size()).name)}`,
    ).href;
  };

  /** Each player's last frame from before a pause, by player. */
  const held = new WeakMap<LivePlayer, HTMLCanvasElement>();

  /** A player's frame now, at its picture's own shape, or `undefined` before it has one. */
  const frameOf = (tile: Tile, player: LivePlayer) => {
    const video = player.querySelector("video");
    const live = liveOfPlayer(tile, player);

    if (video === null || video.readyState < 2) return undefined;

    const canvas = element("canvas");

    const { width, height } = drawnSize(
      video.videoWidth,
      video.videoHeight,
      live === null ? null : streamFor(live, size()).ratio,
    );

    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);

    return canvas;
  };

  /** Shows the frame held for the view the tile shows, while paused. */
  const showHeld = (tile: Tile) => {
    const frame = tile.player === null ? undefined : held.get(tile.player);

    if (frame === undefined) {
      tile.hold.removeAttribute("data-shown");

      return;
    }

    tile.hold.width = frame.width;
    tile.hold.height = frame.height;
    tile.hold.getContext("2d")?.drawImage(frame, 0, 0);
    tile.hold.toggleAttribute("data-shown", true);
  };

  /**
   * The view shown big, and the other small in the corner, named for what
   * a click on it does. The zoom only moves the big one.
   */
  const placeViews = (tile: Tile) => {
    if (tile.player !== null) {
      tile.player.classList.remove("live-inset");
      tile.player.removeAttribute("role");
      tile.player.removeAttribute("tabindex");
      tile.player.removeAttribute("aria-label");
      tile.player.removeAttribute("title");
      tile.figure.prepend(tile.player);
    }

    if (tile.inset !== null) {
      const view = tile.stream.views.find(
        (each) => each.key === tile.inset?.dataset["view"],
      );

      const name = view?.name ?? "the other view";

      tile.inset.classList.add("live-inset");
      tile.inset.dataset["name"] = name;
      tile.inset.setAttribute("role", "button");
      tile.inset.setAttribute("tabindex", "0");
      tile.inset.setAttribute("aria-label", `Show ${name}`);
      tile.inset.title = `Show ${name} (L)`;
      tile.inset.style.transform = "";
      tile.hold.after(tile.inset);
    }

    squeezeTile(tile);
  };

  /** Shows one of a camera's views, such as its telephoto lens, kept for next time. */
  const setLens = (camera: Camera, key: string) => {
    if (key === camera.views[0]?.key) lenses.delete(camera.id);
    else lenses.set(camera.id, key);

    keep(storageKey, { lenses: Object.fromEntries(lenses) });

    const tile = tiles.find((shownTile) => shownTile.stream.id === camera.id);

    // Both play already, so they only swap places
    if (tile?.inset?.dataset["view"] === key) {
      [tile.player, tile.inset] = [tile.inset, tile.player];
      placeViews(tile);
      tile.figure.toggleAttribute(
        "data-loading",
        tile.player?.hasAttribute("data-loading") === true,
      );

      if (paused) showHeld(tile);
    }

    showPicked();
  };

  /** The picked camera's next view, round to its first. */
  const nextLens = () => {
    const camera = streams.find((stream) => stream.id === picked);

    if (camera === undefined || camera.views.length < 2) return;

    const at = camera.views.findIndex(
      (view) => view.key === viewOf(camera)?.key,
    );

    const next = camera.views[(at + 1) % camera.views.length];

    if (next !== undefined) setLens(camera, next.key);
  };

  // A camera with only a still picture shows a new one every few seconds,
  // while the page shows and isn't paused
  setInterval(() => {
    if (paused || !shown()) return;

    for (const tile of tiles) {
      if (tile.picture !== null) connect(tile);
    }
  }, stillEvery);

  /** Puts each source's problem over its cameras' tiles, and takes it off once it's gone. */
  const showTileProblems = () => {
    for (const tile of tiles) {
      const problem = problems.get(tile.stream.source);

      tile.figure.querySelector(".live-problem")?.remove();
      tile.figure.toggleAttribute("data-problem", problem !== undefined);

      if (problem !== undefined) {
        const note = element("p", problem);

        note.className = "live-problem";
        // Under the caption, so the camera's name still shows
        tile.figure.querySelector("figcaption")?.before(note);
      }
    }
  };

  /** Puts the page's worth of cameras in the grid, and starts them unless paused. */
  const render = () => {
    if (grid === null || !shown()) return;

    page = Math.min(page, pages() - 1);
    grid.removeAttribute("aria-busy");

    tiles = streams
      .slice(page * size(), page * size() + size())
      .map((stream) => {
        const figure = element("figure");
        const hold = element("canvas");
        const shownView = viewOf(stream);

        const otherView = stream.views.find(
          (view) => view.key !== shownView?.key,
        );

        const player =
          stream.live === null ? null : livePlayer(stream, shownView);

        const inset =
          player !== null && otherView !== undefined
            ? livePlayer(stream, otherView)
            : null;

        const picture = player === null ? element("img") : null;

        figure.className = "live-tile";
        figure.dataset.loading = "";
        hold.className = "live-hold";
        hold.setAttribute("aria-hidden", "true");

        if (player !== null) figure.append(player);

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

        figure.addEventListener("click", () => pick(stream.id));

        figure.addEventListener("dblclick", () => {
          pick(stream.id);
          toggleSolo();
        });

        const tile: Tile = { stream, figure, player, picture, hold, inset };

        // Whichever of its players is small swaps with the big one, by a
        // click or Enter, and a double click on it doesn't go to one camera
        // alone
        for (const each of [player, inset]) {
          each?.addEventListener("click", () => {
            const key = each.dataset["view"];

            if (each === tile.inset && key !== undefined) setLens(stream, key);
          });

          each?.addEventListener("dblclick", (event) => {
            if (each === tile.inset) event.stopPropagation();
          });

          each?.addEventListener("keydown", (event) => {
            if (each !== tile.inset || !["Enter", " "].includes(event.key)) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            each.click();
          });
        }

        placeViews(tile);

        return tile;
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

    arrangeGrid(grid);

    stopWaiting();

    // On the page each player makes its video: the page's controls stand in
    // for the video's own, and it starts quiet until its sound is picked
    for (const tile of tiles) {
      for (const player of [tile.player, tile.inset]) {
        const video = player?.querySelector("video") ?? null;

        if (video === null) continue;

        video.controls = false;
        video.muted = true;

        // The browser mutes sound that started without a click or a key, so
        // it's held back until the next one, still on for that camera
        video.addEventListener("volumechange", () => {
          const shown = soundTile();

          if (
            video.muted &&
            !soundHeld &&
            shown?.player === player &&
            soundOf(shown.stream).on
          ) {
            soundHeld = true;
            showSound();
          }
        });
      }

      if (!paused) connect(tile);
    }

    showTileProblems();
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

  /** Smart tiling or fixed layouts, kept in this browser. */
  const setTiling = (next: Tiling) => {
    if (next === tiling) return;

    tiling = next;
    keep(storageKey, { tiling });

    if (grid !== null) arrangeGrid(grid);

    showZoom();
    showControls();
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

    if (paused) stopWaiting();

    for (const tile of tiles) {
      // A still picture stays as it is while paused
      if (tile.player === null) {
        if (!paused) connect(tile);
      } else if (paused) {
        // The last frame stays up while the stream is closed, each view's
        // its own, for a swap while paused
        for (const player of [tile.player, tile.inset]) {
          const frame = player === null ? undefined : frameOf(tile, player);

          if (player !== null && frame !== undefined) held.set(player, frame);

          player?.ondisconnect();
        }

        showHeld(tile);
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
        ? drawnSize(size.width, size.height, ratioOf(tile))
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

  if (layoutMore !== null) {
    on(layoutMore, "select", (event) => setLayout(Number(event.detail.value)));
  }

  if (viewMenu !== null) {
    viewMenu.setAttribute("icon", phSquaresFour);
    on(viewMenu, "select", (event) => {
      const chosen = tilings.find((each) => each.value === event.detail.value);

      if (chosen !== undefined) setTiling(chosen.value);
    });
  }

  // Smart tiling follows the space the cameras have, as the window's size
  // changes or they go full screen
  const area = grid?.parentElement ?? null;

  if (grid !== null && area !== null) {
    new ResizeObserver(() => {
      if (tiling !== "smart") return;

      arrangeGrid(grid);
      showZoom();
    }).observe(area);
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

  if (pageSelect !== null) {
    on(pageSelect, "change", () => {
      goTo(Number(pageSelect.value));
      requestAnimationFrame(() => stage?.focus({ preventScroll: true }));
    });
  }

  // Zoom, each camera's its own and kept, once in tiles and once alone, as
  // on the Recordings page, and each of a camera's views its own, since
  // their pictures differ. A drag or the wheel on a camera picks it
  const zoomTileOf = (tile: Tile): ZoomTile => {
    const view = viewOf(tile.stream);

    return {
      id:
        view === undefined || view.key === tile.stream.views[0]?.key
          ? tile.stream.id
          : `${tile.stream.id}#${view.key}`,
      figure: tile.figure,
      parts: [tile.player, tile.picture, tile.hold].flatMap((part) =>
        part === null ? [] : [part],
      ),
      size: () => {
        const source =
          tile.picture ?? tile.player?.querySelector("video") ?? null;

        const size = source === null ? { width: 0, height: 0 } : sizeOf(source);

        // A squeezed stream's frame is drawn at the picture's own shape
        return source instanceof HTMLVideoElement
          ? drawnSize(size.width, size.height, ratioOf(tile))
          : size;
      },
    };
  };

  const zoom = pictureZoom({
    area: grid,
    tiles: () => tiles.map(zoomTileOf),
    picked: () => {
      const tile = tiles.find((shownTile) => shownTile.stream.id === picked);

      return tile === undefined ? undefined : zoomTileOf(tile);
    },
    views: viewsNow,
    zoomOut: zoomOutButton,
    zoomFit: zoomFitButton,
    zoomIn: zoomInButton,
    fit: fitToggle,
    onPick: (zoomed) => {
      const tile = tiles.find((shown) => shown.figure === zoomed.figure);

      if (tile !== undefined) pick(tile.stream.id);
    },
    steers: (tile, gesture) => steer.steers(tile.figure, gesture),
    onChange: keepViews,
  });

  showZoom = zoom.show;

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
    [
      "Escape",
      () => {
        if (steer.on()) steer.leave();
        else if (solo === undefined) unpick();
        else leaveSolo();
      },
    ],
    ["Backspace", leaveSolo],
    // In Move mode, the lens zooms where it changes the picture shown
    ["+", () => steer.zoomStep(1) || zoom.step(1)],
    ["=", () => steer.zoomStep(1) || zoom.step(1)],
    ["-", () => steer.zoomStep(-1) || zoom.step(-1)],
    ["0", zoom.whole],
    ["s", capture],
    ["m", toggleMove],
    ["p", () => picture.toggle()],
    ["u", toggleSound],
    ["l", nextLens],
    ["z", zoom.toggleFill],
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
    ["t", () => setTiling(tiling === "smart" ? "fixed" : "smart")],
  ]);

  /** The arrow keys, which steer the camera in Move mode while they're held. */
  const isArrow = (
    key: string | undefined,
  ): key is "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" =>
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown";

  document.addEventListener("keydown", (event) => {
    if (!shown()) return;

    const key = controlKey(event);

    if (steer.on() && isArrow(key)) {
      event.preventDefault();

      if (!event.repeat) steer.key(key, true);

      return;
    }

    const action = keys.get(key ?? "");

    // Enter on a control presses it, as it should
    const onControl = event.target !== stage && event.target !== document.body;

    if (action === undefined || (key === "Enter" && onControl)) return;

    event.preventDefault();
    action();
  });

  // Whatever has the focus by then, a key let go stops it
  document.addEventListener("keyup", (event) => {
    if (isArrow(event.key)) steer.key(event.key, false);
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
    showProblems: (next) => {
      problems = next;
      showTileProblems();
    },
    stop: () => {
      steer.leave();
      picture.close();
      tiles = [];
      // Back to placeholders, so the page comes back without a jump
      placeholders();
    },
    focus,
  };
};
