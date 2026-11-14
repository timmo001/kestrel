/**
 * Several cameras' players on one clock, for the Recordings page. Each
 * ticked camera has a tile with its own video and player. At each moment,
 * the cameras that recorded then play their recording from that point, and
 * the rest show a placeholder until their next recording starts. One
 * camera's video keeps the time: the picked one when it recorded then, or
 * else the first that did. The others are put back on its time when they
 * drift. With nothing recorded on any of them, it runs on to the next
 * recording on any. Between clips, a tile holds its last frame and fades it
 * out over the next. While one camera waits for video, the others hold
 * where they are, so they play on together rather than drifting apart. One
 * camera can be shown alone, the others let go until the grid comes back.
 * Why a camera's video stopped shows over its own tile. It answers what the page asks of one player, so the page
 * drives one camera or several the same way.
 */
import type { CameraId } from "@timmo001/kestrel-core";
import { cameraLabel } from "./cameras.ts";
import { momentAt, nextMoment, type Track } from "./moments.ts";
import {
  fullView,
  playerFor,
  sameView,
  toSeconds,
  type Clip,
  type Player,
  type View,
} from "./recording-player.ts";
import { element } from "./shared.ts";
import { applyTiling, clearTiling, tilingFor } from "./tiling.ts";

/** A camera's tile, as the page sees it. */
export interface GroupTile {
  readonly camera: CameraId;
  readonly figure: HTMLElement;
  readonly video: HTMLVideoElement;
}

/** One camera's tile: its figure, video, held frame and player. */
interface Tile extends GroupTile {
  readonly hold: HTMLCanvasElement;
  readonly player: Player;
}

export interface GroupEvents {
  /** The time moved on. */
  readonly onTime: () => void;
  /** It played, paused or stopped, or another camera keeps the time. */
  readonly onState: () => void;
  /** A tile other than the picked camera's was clicked. */
  readonly onPick: (camera: CameraId) => void;
}

export interface Group extends Player {
  /** The cameras to play, in order, and the picked one, which comes first and largest. */
  readonly setCameras: (tracks: ReadonlyArray<Track>, picked: CameraId) => void;
  /** Shows the picked camera alone, or every camera again, on the same clock. */
  readonly solo: (on: boolean) => void;
  /**
   * Tiles the cameras smartly, sized to the space they have as on Live, or
   * in each count's fixed layout; and again as that space changes size.
   */
  readonly tile: (smart: boolean) => void;
  /** The video that keeps the time, for a still, a held frame and the frame step. */
  readonly video: () => HTMLVideoElement | undefined;
  /** The picked camera's video. */
  readonly lead: () => HTMLVideoElement | undefined;
  /** Each camera's tile and video, for the zoom. */
  readonly tiles: () => ReadonlyArray<GroupTile>;
  readonly paused: () => boolean;
  readonly resume: () => void;
  readonly pause: () => void;
  /** Sets every video's playback rate, now and for what loads next. */
  readonly rate: (rate: number) => void;
  /** Pauses and moves every video on by `seconds`. */
  readonly step: (seconds: number) => void;
}

/** How many cameras the layouts take at once. */
export const mostCameras = 4;

/** How long the cameras hold for one waiting for its video, in milliseconds. */
const holdLimit = 10_000;

const isPlaying = (video: HTMLVideoElement) =>
  !video.paused && video.readyState >= 3;

/**
 * Holds a tile's last frame over it while its video loads another clip, then
 * fades it out once the new one draws, rather than a shimmer between clips.
 */
const holdFrame = ({ video, hold }: Tile) => {
  if (video.readyState < 2 || video.videoWidth === 0) return;

  hold.width = video.videoWidth;
  hold.height = video.videoHeight;
  hold.getContext("2d")?.drawImage(video, 0, 0);
  hold.style.transform = video.style.transform;
  hold.style.objectFit = getComputedStyle(video).objectFit;
  hold.toggleAttribute("data-shown", true);

  const release = () => hold.removeAttribute("data-shown");
  const timer = setTimeout(release, 4000);

  video.addEventListener(
    "loadeddata",
    () =>
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        release();
      }),
    { once: true },
  );
};

const releaseFrame = ({ hold }: Tile) => hold.removeAttribute("data-shown");

/** Plays several cameras' recordings in `grid`, as one. */
export const playerGroup = (grid: HTMLElement, events: GroupEvents): Group => {
  const tiles = new Map<CameraId, Tile>();
  let tracks: ReadonlyArray<Track> = [];
  let picked: CameraId = "";
  /** The tile whose video keeps the time. */
  let driver: Tile | undefined;
  /** Whether it should be playing, rather than paused or stopped. */
  let playing = false;
  let playbackRate = 1;
  let view: View = fullView;
  /** Whether the picked camera shows alone. */
  let alone = false;
  /** Whether the tiles are sized to the space, rather than in fixed layouts. */
  let smart = true;

  /** The cameras showing: every one, or the picked one alone. */
  const shownTracks = () =>
    alone ? tracks.filter((track) => track.camera === picked) : tracks;

  /**
   * Whether a tile should be showing video but has none to play yet, such
   * as while its clip loads. A tile with a problem waits for nothing.
   */
  const isWaiting = (tile: Tile) =>
    tile.player.clip() !== undefined &&
    tile.figure.dataset.empty === undefined &&
    !tile.figure.hasAttribute("data-problem") &&
    !tile.video.ended &&
    tile.video.readyState < 3;

  /** When each tile waiting for video started to. */
  const waitingSince = new Map<Tile, number>();

  /** Whether a tile waiting holds the others: only for so long, so one whose video never comes doesn't stop them all. */
  const isStalled = (tile: Tile) => {
    if (!isWaiting(tile)) {
      waitingSince.delete(tile);

      return false;
    }

    const since = waitingSince.get(tile);

    if (since === undefined) {
      waitingSince.set(tile, Date.now());
      // Looked again once it's held as long as it may
      setTimeout(() => holdBack(), holdLimit);

      return true;
    }

    return Date.now() - since < holdLimit;
  };

  const held = () => [...tiles.values()].some(isStalled);

  /**
   * Holds the tiles with video where they are while another waits for its
   * own, then plays them on together. At speed the cameras load at
   * different rates, and one left playing ran ahead, so the slow one was
   * put back on its time with a seek that loaded again and fell further
   * behind.
   */
  const holdBack = () => {
    if (!playing) return;

    const hold = held();

    for (const tile of tiles.values()) {
      if (
        tile.player.clip() === undefined ||
        tile.figure.dataset.empty !== undefined ||
        tile.video.ended ||
        isStalled(tile)
      ) {
        continue;
      }

      if (hold && !tile.video.paused) tile.video.pause();
      else if (!hold && tile.video.paused) {
        void tile.video.play().catch(() => undefined);
      }
    }
  };

  /** The recorder second the clock is at, from the video keeping the time. */
  const now = () => {
    const clip = driver?.player.clip();
    const offset = driver?.player.offset();

    return clip === undefined || offset === undefined
      ? undefined
      : toSeconds(clip.begin) + offset;
  };

  /**
   * How far a follower may drift before it's put back: half a second, or a
   * quarter of a second's play at speed, as each seek can cost a reload
   */
  const tolerance = () => Math.max(0.5, playbackRate * view.speedUp * 0.25);

  /** Puts every tile on the clock at `at`, in recorder seconds; returns the loads it started. */
  const align = (at: number, exact: boolean): Array<Promise<void>> => {
    const moment = momentAt(shownTracks(), picked, at);

    if (moment.driver === undefined) {
      const next = nextMoment(shownTracks(), at);

      // Nothing on any camera until the end of the day: stop there
      if (next === undefined) {
        playing = false;

        for (const tile of tiles.values()) tile.video.pause();

        events.onState();

        return [];
      }

      return align(next, true);
    }

    const keeper = tiles.get(moment.driver);
    const changed = keeper !== driver;
    const started: Array<Promise<void>> = [];

    driver = keeper;

    for (const { camera, recording } of moment.shown) {
      const tile = tiles.get(camera);

      if (tile === undefined) continue;

      if (recording === undefined) {
        if (tile.player.clip() !== undefined) tile.player.stop();

        releaseFrame(tile);
        tile.figure.dataset.empty = "";
        continue;
      }

      delete tile.figure.dataset.empty;

      const into = at - toSeconds(recording.begin);
      const current = tile.player.clip();

      // The same recording, grown since it loaded, as today's newest does,
      // loads again from where it got to once the playhead reaches its old end
      const grown =
        current?.begin === recording.begin &&
        current.end < recording.end &&
        at >= toSeconds(current.end);

      if (current?.begin !== recording.begin || grown) {
        holdFrame(tile);
        started.push(tile.player.play(recording, into, playing));
        continue;
      }

      // A tile still loading would only start loading again
      const drift = Math.abs((tile.player.offset() ?? into) - into);

      if (exact || (isPlaying(tile.video) && drift > tolerance())) {
        tile.player.seek(into);
      }

      // A tile held for another loading plays on once that one can too
      if (playing && tile.video.paused && !held()) {
        void tile.video.play().catch(() => undefined);
      } else if (!playing && !tile.video.paused) {
        tile.video.pause();
      }
    }

    if (changed) events.onState();

    return started;
  };

  const makeTile = (camera: CameraId): Tile => {
    const figure = element("figure");
    const video = element("video");
    const hold = element("canvas");
    const label = cameraLabel(camera);

    figure.className = "player-tile";
    figure.dataset.camera = camera;
    // A shimmer from when a clip starts loading until its first frame, so
    // the picture fades in rather than popping in
    video.addEventListener("loadstart", () => {
      figure.dataset.loading = "";
    });

    for (const type of ["loadeddata", "emptied"]) {
      video.addEventListener(type, () => {
        delete figure.dataset.loading;
      });
    }

    video.className = "player-video";
    video.muted = true;
    video.playsInline = true;
    video.defaultPlaybackRate = playbackRate;
    video.playbackRate = playbackRate;
    hold.className = "player-hold";
    hold.ariaHidden = "true";
    // Why video stopped coming, over the tile's picture, until it loads a
    // clip again or the server answers with video
    const problem = element("div");

    problem.className = "player-tile-problem";
    problem.role = "status";

    const showProblem = (message: string | undefined) => {
      problem.textContent =
        message === undefined ? "" : `Video stopped: ${message}`;
      figure.toggleAttribute("data-problem", message !== undefined);
      // One that's stopped holds the others back no longer
      holdBack();
    };

    for (const type of ["loadstart", "emptied"]) {
      video.addEventListener(type, () => showProblem(undefined));
    }

    // Each camera prints its own channel on the picture; an empty tile says
    // which it is
    figure.append(
      video,
      hold,
      element("p", `${label}: nothing recorded`),
      problem,
    );

    const player = playerFor(video, {
      onProblem: showProblem,
      onLoad: () => showProblem(undefined),
      // The clock runs on from the end of the recording keeping it; a
      // follower's end only shows its placeholder
      onEnded: (ended) => {
        const at =
          tile === driver
            ? toSeconds(ended.end)
            : (now() ?? toSeconds(ended.end));

        void Promise.all(align(at, tile === driver));
      },
    });

    const tile = { camera, figure, video, hold, player };

    player.view(view);

    video.addEventListener("timeupdate", () => {
      if (tile !== driver) return;

      const at = now();

      if (at !== undefined) void Promise.all(align(at, false));

      events.onTime();
    });

    for (const type of ["play", "pause", "emptied"]) {
      video.addEventListener(type, () => {
        if (tile === driver) events.onState();
      });
    }

    // Each change in whether it has video to play holds the others, or lets
    // them go
    for (const type of [
      "waiting",
      "canplay",
      "playing",
      "seeked",
      "emptied",
      "ended",
    ]) {
      video.addEventListener(type, holdBack);
    }

    figure.addEventListener("click", () => {
      if (camera !== picked) events.onPick(camera);
    });

    return tile;
  };

  const stop = () => {
    for (const tile of tiles.values()) {
      tile.player.stop();
      releaseFrame(tile);
      delete tile.figure.dataset.empty;
    }

    driver = undefined;
    playing = false;
    events.onState();
  };

  /**
   * Lays the grid out for the cameras showing. While the picked one shows
   * alone, the others let go of their video, so it has the recorder's
   * bandwidth to itself.
   */
  const arrange = () => {
    const count = alone ? 1 : Math.max(tiles.size, 1);
    const area = grid.parentElement;

    // Hidden, the space measures nothing, so the last tiling stays until it
    // shows again
    const tiled =
      smart && count > 1 && area !== null
        ? tilingFor(count, area.clientWidth, area.clientHeight)
        : undefined;

    grid.toggleAttribute("data-alone", alone);

    if (smart && count > 1) {
      grid.dataset.layout = "smart";

      if (tiled !== undefined) applyTiling(grid, tiled);
    } else {
      grid.dataset.layout = String(count);
      clearTiling(grid);
    }

    for (const tile of tiles.values()) {
      tile.figure.toggleAttribute("data-picked", tile.camera === picked);

      if (!alone || tile.camera === picked) continue;

      if (tile.player.clip() !== undefined) tile.player.stop();

      releaseFrame(tile);

      if (tile === driver) driver = undefined;
    }
  };

  return {
    setCameras: (next, pickedCamera) => {
      const at = now();
      const wanted = new Set(next.map((track) => track.camera));

      for (const [camera, tile] of tiles) {
        if (!wanted.has(camera)) {
          tile.player.stop();
          tile.figure.remove();
          tiles.delete(camera);

          if (tile === driver) driver = undefined;
        }
      }

      tracks = next;
      picked = pickedCamera;

      // The picked camera first, so it's the large one in three
      const order = [
        ...next.filter((track) => track.camera === picked),
        ...next.filter((track) => track.camera !== picked),
      ];

      for (const track of order) {
        if (!tiles.has(track.camera)) {
          tiles.set(track.camera, makeTile(track.camera));
        }
      }

      grid.replaceChildren(
        ...order.flatMap((track) => tiles.get(track.camera)?.figure ?? []),
      );
      arrange();

      // Cameras joining part way through come in at the clock's time
      if (at !== undefined) void Promise.all(align(at, false));
    },
    solo: (on) => {
      if (on === alone) return;

      const at = now();

      alone = on;
      arrange();

      // Back to the grid, the others load again at the clock's time
      if (at !== undefined) void Promise.all(align(at, false));

      events.onState();
    },
    tile: (next) => {
      smart = next;
      arrange();
    },
    play: async (clip: Clip, from = 0, autoplay = true) => {
      playing = autoplay;

      const at = toSeconds(clip.begin) + from;

      if (momentAt(shownTracks(), picked, at).driver !== undefined) {
        await Promise.all(align(at, true));

        return;
      }

      // A stretch none of the lists has, such as a kept position from
      // before they loaded: its own camera plays it alone
      const tile = tiles.get(clip.camera) ?? tiles.values().next().value;

      if (tile === undefined) return;

      driver = tile;
      holdFrame(tile);
      await tile.player.play(clip, from, autoplay);
    },
    stop,
    seek: (to) => {
      const clip = driver?.player.clip();

      if (clip !== undefined)
        void Promise.all(align(toSeconds(clip.begin) + to, true));
    },
    view: (next) => {
      // Another view loads each clip again, from the other stream
      if (!sameView(next, view)) {
        for (const tile of tiles.values()) {
          if (tile.player.clip() !== undefined) holdFrame(tile);
        }
      }

      view = next;
      // The sub stream's pictures are squeezed, which the styles undo
      grid.dataset.stream = next.stream;

      for (const tile of tiles.values()) tile.player.view(next);
    },
    clip: () => driver?.player.clip(),
    offset: () => driver?.player.offset(),
    time: () => driver?.player.time(),
    video: () => driver?.video,
    lead: () => tiles.get(picked)?.video,
    tiles: () => [...tiles.values()],
    // Held for another camera's video, it's still playing
    paused: () =>
      driver === undefined || !playing || (driver.video.paused && !held()),
    resume: () => {
      playing = true;

      const at = now();

      if (at !== undefined) void Promise.all(align(at, false));

      if (driver !== undefined && driver.video.paused && !held()) {
        void driver.video.play().catch(() => undefined);
      }

      holdBack();
    },
    pause: () => {
      playing = false;

      for (const tile of tiles.values()) tile.video.pause();
    },
    rate: (rate) => {
      playbackRate = rate;

      for (const tile of tiles.values()) {
        tile.video.defaultPlaybackRate = rate;
        tile.video.playbackRate = rate;
      }
    },
    step: (seconds) => {
      playing = false;

      for (const tile of tiles.values()) {
        tile.video.pause();

        if (tile.player.clip() !== undefined) tile.video.currentTime += seconds;
      }
    },
  };
};
