/**
 * Several cameras' players on one clock, for the Recordings page. Each
 * ticked camera has a tile with its own video and player. At each moment,
 * the cameras that recorded then play their recording from that point, and
 * the rest show a placeholder until their next recording starts. One
 * camera's video keeps the time: the picked one when it recorded then, or
 * else the first that did. The others are put back on its time when they
 * drift. With nothing recorded on any of them, it runs on to the next
 * recording on any. It answers what the page asks of one player, so the page
 * drives one camera or several the same way.
 */
import type { CameraId } from "@timmo001/kestrel-core";
import { cameraLabel } from "./cameras.ts";
import { momentAt, nextMoment, type Track } from "./moments.ts";
import {
  fullView,
  playerFor,
  toSeconds,
  type Clip,
  type Player,
  type View,
} from "./recording-player.ts";
import { element } from "./shared.ts";

/** A camera's tile, as the page sees it. */
export interface GroupTile {
  readonly camera: CameraId;
  readonly figure: HTMLElement;
  readonly video: HTMLVideoElement;
}

/** One camera's tile: its figure, video and player. */
interface Tile extends GroupTile {
  readonly player: Player;
}

export interface GroupEvents {
  /** Why video stopped coming, with the camera when several play. */
  readonly onProblem: (message: string) => void;
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

const isPlaying = (video: HTMLVideoElement) =>
  !video.paused && video.readyState >= 3;

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
    const moment = momentAt(tracks, picked, at);

    if (moment.driver === undefined) {
      const next = nextMoment(tracks, at);

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

        tile.figure.dataset.empty = "";
        continue;
      }

      delete tile.figure.dataset.empty;

      const into = at - toSeconds(recording.begin);
      const current = tile.player.clip();

      if (current?.begin !== recording.begin) {
        started.push(tile.player.play(recording, into, playing));
        continue;
      }

      // A tile still loading would only start loading again
      const drift = Math.abs((tile.player.offset() ?? into) - into);

      if (exact || (isPlaying(tile.video) && drift > tolerance())) {
        tile.player.seek(into);
      }

      if (playing && tile.video.paused) {
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
    // Each camera prints its own channel on the picture; an empty tile says
    // which it is
    figure.append(video, element("p", `${label}: nothing recorded`));

    const player = playerFor(video, {
      onProblem: (message) =>
        events.onProblem(tiles.size > 1 ? `${label}: ${message}` : message),
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

    const tile = { camera, figure, video, player };

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

    figure.addEventListener("click", () => {
      if (camera !== picked) events.onPick(camera);
    });

    return tile;
  };

  const stop = () => {
    for (const tile of tiles.values()) {
      tile.player.stop();
      delete tile.figure.dataset.empty;
    }

    driver = undefined;
    playing = false;
    events.onState();
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
      grid.dataset.layout = String(Math.max(order.length, 1));

      for (const tile of tiles.values()) {
        tile.figure.toggleAttribute("data-picked", tile.camera === picked);
      }

      // Cameras joining part way through come in at the clock's time
      if (at !== undefined) void Promise.all(align(at, false));
    },
    play: async (clip: Clip, from = 0, autoplay = true) => {
      playing = autoplay;

      const at = toSeconds(clip.begin) + from;

      if (momentAt(tracks, picked, at).driver !== undefined) {
        await Promise.all(align(at, true));

        return;
      }

      // A stretch none of the lists has, such as a kept position from
      // before they loaded: its own camera plays it alone
      const tile = tiles.get(clip.camera) ?? tiles.values().next().value;

      if (tile === undefined) return;

      driver = tile;
      await tile.player.play(clip, from, autoplay);
    },
    stop,
    seek: (to) => {
      const clip = driver?.player.clip();

      if (clip !== undefined)
        void Promise.all(align(toSeconds(clip.begin) + to, true));
    },
    view: (next) => {
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
    paused: () => driver === undefined || driver.video.paused,
    resume: () => {
      playing = true;

      const at = now();

      if (at !== undefined) void Promise.all(align(at, false));

      if (driver !== undefined && driver.video.paused) {
        void driver.video.play().catch(() => undefined);
      }
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
