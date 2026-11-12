/**
 * Several channels' players on one clock, for the Recordings page. Each
 * ticked channel has a tile with its own video and player. At each moment,
 * the channels that recorded then play their recording from that point, and
 * the rest show a placeholder until their next recording starts. One
 * channel's video keeps the time: the picked one when it recorded then, or
 * else the first that did. The others are put back on its time when they
 * drift. With nothing recorded on any of them, it runs on to the next
 * recording on any. It answers what the page asks of one player, so the page
 * drives one channel or several the same way.
 */
import { momentAt, nextMoment, type Track } from "./moments.ts";
import {
  fullView,
  playerFor,
  toSeconds,
  type Clip,
  type Player,
  type View,
} from "./player.ts";
import { element } from "./shared.ts";

/** One channel's tile: its figure, video and player. */
interface Tile {
  readonly channel: number;
  readonly figure: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly player: Player;
}

export interface GroupEvents {
  /** Why video stopped coming, with the channel when several play. */
  readonly onProblem: (message: string) => void;
  /** The time moved on. */
  readonly onTime: () => void;
  /** It played, paused or stopped, or another channel keeps the time. */
  readonly onState: () => void;
  /** A tile other than the picked channel's was clicked. */
  readonly onPick: (channel: number) => void;
}

export interface Group extends Player {
  /** The channels to play, in order, and the picked one, which comes first and largest. */
  readonly setChannels: (tracks: ReadonlyArray<Track>, picked: number) => void;
  /** The video that keeps the time, for a still, a held frame and the frame step. */
  readonly video: () => HTMLVideoElement | undefined;
  /** The picked channel's video, which the zoom acts on. */
  readonly lead: () => HTMLVideoElement | undefined;
  readonly paused: () => boolean;
  readonly resume: () => void;
  readonly pause: () => void;
  /** Sets every video's playback rate, now and for what loads next. */
  readonly rate: (rate: number) => void;
  /** Pauses and moves every video on by `seconds`. */
  readonly step: (seconds: number) => void;
}

/** How many channels the layouts take at once. */
export const mostChannels = 4;

const isPlaying = (video: HTMLVideoElement) =>
  !video.paused && video.readyState >= 3;

/** Plays several channels' recordings in `grid`, as one. */
export const playerGroup = (grid: HTMLElement, events: GroupEvents): Group => {
  const tiles = new Map<number, Tile>();
  let tracks: ReadonlyArray<Track> = [];
  let picked = 0;
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

      // Nothing on any channel until the end of the day: stop there
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

    for (const { channel, recording } of moment.shown) {
      const tile = tiles.get(channel);

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

  const makeTile = (channel: number): Tile => {
    const figure = element("figure");
    const video = element("video");

    figure.className = "player-tile";
    figure.dataset.channel = String(channel);
    video.className = "player-video";
    video.muted = true;
    video.playsInline = true;
    video.defaultPlaybackRate = playbackRate;
    video.playbackRate = playbackRate;
    // Each camera prints its own channel on the picture; an empty tile says
    // which it is
    figure.append(video, element("p", `Ch ${channel}: nothing recorded`));

    const player = playerFor(video, {
      onProblem: (message) =>
        events.onProblem(
          tiles.size > 1 ? `Ch ${channel}: ${message}` : message,
        ),
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

    const tile = { channel, figure, video, player };

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
      if (channel !== picked) events.onPick(channel);
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
    setChannels: (next, pickedChannel) => {
      const at = now();
      const wanted = new Set(next.map((track) => track.channel));

      for (const [channel, tile] of tiles) {
        if (!wanted.has(channel)) {
          tile.player.stop();
          tile.figure.remove();
          tiles.delete(channel);

          if (tile === driver) driver = undefined;
        }
      }

      tracks = next;
      picked = pickedChannel;

      // The picked channel first, so it's the large one in three
      const order = [
        ...next.filter((track) => track.channel === picked),
        ...next.filter((track) => track.channel !== picked),
      ];

      for (const track of order) {
        if (!tiles.has(track.channel)) {
          tiles.set(track.channel, makeTile(track.channel));
        }
      }

      grid.replaceChildren(
        ...order.flatMap((track) => tiles.get(track.channel)?.figure ?? []),
      );
      grid.dataset.layout = String(Math.max(order.length, 1));

      for (const tile of tiles.values()) {
        tile.figure.toggleAttribute("data-picked", tile.channel === picked);
      }

      // Channels joining part way through come in at the clock's time
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
      // before they loaded: its own channel plays it alone
      const tile = tiles.get(clip.channel) ?? tiles.values().next().value;

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
