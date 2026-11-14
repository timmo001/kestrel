/**
 * One camera's recording player. It plays the server's MP4 of a recording through
 * Media Source Extensions rather than a plain video source: the length is
 * known from the start, a seek past what's loaded asks the server for video
 * from there, and only a few minutes around the playhead stay in memory, as
 * the recorder sends far faster than it plays. H.264 and H.265 both play
 * where the browser can, each MP4 telling which it holds.
 */
import { serverUrl } from "./api.ts";

/** A stretch of one camera's recording, in recorder times. */
export interface Clip {
  readonly camera: string;
  readonly begin: string;
  readonly end: string;
}

/** A recorder time as seconds since 1970, read as UTC: the recorder keeps no zone. */
export const toSeconds = (time: string) => Date.parse(`${time}Z`) / 1000;

/** Seconds since 1970 as a recorder time. */
export const fromSeconds = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 19);

/**
 * Which of a camera's streams a clip plays from, how many times faster
 * than it was recorded the server makes it, and whether it's key frames
 * only, one per `every` seconds of recording. Browsers play no faster than
 * 16 times, and the full stream downloads at about 17, so faster speeds come
 * from the recorder's own fast forward, key frames only, sped up by the
 * server.
 */
export interface View {
  readonly stream: "main" | "sub";
  readonly speedUp: number;
  readonly every?: number | undefined;
}

/** The full stream, at the speed it was recorded. */
export const fullView: View = { stream: "main", speedUp: 1 };

/** Whether two views load the same video. */
export const sameView = (a: View, b: View) =>
  a.stream === b.stream && a.speedUp === b.speedUp && a.every === b.every;

/** The server's MP4 of a clip, to play or, with `download`, to save as a file. */
export const clipUrl = (clip: Clip, download = false, view = fullView) => {
  // The camera's id is its route's two path segments, such as `swann/3`
  const url = serverUrl(`api/cameras/${clip.camera}/video`);

  url.searchParams.set("begin", clip.begin);
  url.searchParams.set("end", clip.end);

  if (view.stream !== "main") url.searchParams.set("stream", view.stream);

  if (view.speedUp !== 1) url.searchParams.set("speedUp", String(view.speedUp));

  if (view.every !== undefined) {
    url.searchParams.set("every", String(view.every));
  }

  if (download) url.searchParams.set("download", "true");

  return url.href;
};

/** Seconds of video loaded ahead of the playhead before the download waits. */
const ahead = 90;

/** Seconds of video kept behind the playhead, for a short skip back. */
const behind = 30;

/** Any H.264 the recorder sends fits this; the MP4's own header has the exact profile. */
const avcType = 'video/mp4; codecs="avc1.640028"';

/** Any H.265 a camera sends, such as a Reolink hub's, as the server writes it. */
const hevcType = 'video/mp4; codecs="hvc1.1.6.L150.90"';

const encoder = new TextEncoder();

const hvcC = encoder.encode("hvcC");

const avcC = encoder.encode("avcC");

const holds = (bytes: Uint8Array, box: Uint8Array) =>
  bytes.some(
    (_, index) =>
      index + box.length <= bytes.length &&
      box.every((each, offset) => bytes[index + offset] === each),
  );

/** An MP4's type from its start, by its sample entry's configuration box, or undefined until that has come. */
const typeOf = (bytes: Uint8Array) => {
  if (holds(bytes, hvcC)) return hevcType;

  if (holds(bytes, avcC)) return avcType;

  return undefined;
};

/** How much of an MP4's start is read looking for its type before giving up. */
const headLimit = 256 * 1024;

const once = (target: EventTarget, type: string) =>
  new Promise<void>((resolve) => {
    target.addEventListener(type, () => resolve(), { once: true });
  });

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const isQuotaError = (error: Error) =>
  error instanceof DOMException && error.name === "QuotaExceededError";

export interface Player {
  /**
   * Loads a clip, from `from` seconds in (its start by default), in place of
   * whatever was playing, and plays it unless `autoplay` is false.
   */
  readonly play: (
    clip: Clip,
    from?: number,
    autoplay?: boolean,
  ) => Promise<void>;
  /** Stops and lets go of the video. */
  readonly stop: () => void;
  /** Moves to `to` seconds into the playing clip. */
  readonly seek: (to: number) => void;
  /** Plays from another stream or speed-up, picking up where it was. */
  readonly view: (next: View) => void;
  /** What's playing, if anything. */
  readonly clip: () => Clip | undefined;
  /** Seconds into the playing clip at the playhead. */
  readonly offset: () => number | undefined;
  /** The recorder time at the playhead. */
  readonly time: () => string | undefined;
}

export interface PlayerEvents {
  /** Why video stopped coming, such as the recorder dropping the download. */
  readonly onProblem: (message: string) => void;
  /** The server answered a load with video, so any earlier problem is past. */
  readonly onLoad: () => void;
  /** A clip played to its end. */
  readonly onEnded: (clip: Clip) => void;
}

/** How far past the start of a load a seek waits for it rather than starting another. */
const loadReach = 10;

/** Plays clips in `video`, telling `events` when one ends or stops early. */
export const playerFor = (
  video: HTMLVideoElement,
  events: PlayerEvents,
): Player => {
  let current: Clip | undefined;
  let source: MediaSource | undefined;
  let buffer: SourceBuffer | undefined;
  let loading: AbortController | undefined;
  let loadingFrom = 0;
  /** Where in the clip the latest load started, in seconds. */
  let loadStart = -1;
  /** The type the source buffer reads, H.264 or H.265. */
  let bufferType = "";
  /** Where the video's time 0 is in the clip: 0, unless the browser plays the MP4 directly from a later start. */
  let base = 0;
  let objectUrl = "";
  /** The stream and speed-up: a second of the video is `view.speedUp` seconds of the clip. */
  let view = fullView;

  const ranges = () => {
    const buffered = buffer?.buffered;

    return Array.from({ length: buffered?.length ?? 0 }, (_, index) => ({
      start: buffered?.start(index) ?? 0,
      end: buffered?.end(index) ?? 0,
    }));
  };

  const isLoaded = (time: number) =>
    ranges().some((range) => range.start <= time && time < range.end - 0.2);

  /** The end of the loaded stretch the playhead is in. */
  const loadedUntil = () =>
    ranges().find(
      (range) =>
        range.start <= video.currentTime && video.currentTime <= range.end,
    )?.end ?? video.currentTime;

  const settle = async (target: SourceBuffer) => {
    while (target.updating) await once(target, "updateend");
  };

  /** Drops what's more than `keep` seconds behind the playhead. */
  const trim = async (target: SourceBuffer, keep: number) => {
    const until = video.currentTime - keep;

    if (ranges().some((range) => range.start < until)) {
      await settle(target);
      target.remove(0, until);
      await settle(target);
    }
  };

  const append = async (
    target: SourceBuffer,
    signal: AbortSignal,
    chunk: Uint8Array<ArrayBuffer>,
  ) => {
    // Plenty is loaded: wait for the playhead, which holds the download back
    while (!signal.aborted && loadedUntil() - video.currentTime > ahead) {
      await pause(1000);
    }

    for (let tries = 0; !signal.aborted; tries++) {
      await trim(target, behind);
      await settle(target);

      if (signal.aborted) return;

      try {
        target.appendBuffer(chunk);
        await once(target, "updateend");

        return;
      } catch (error) {
        if (!(error instanceof Error) || !isQuotaError(error) || tries > 5) {
          throw error;
        }

        // The browser's budget is full: keep less behind and wait to play on
        await trim(target, 2);
        await pause(1000);
      }
    }
  };

  /** Loads video from `from` seconds into the clip, in place of any load under way. */
  const load = async (from: number) => {
    const clip = current;
    const media = source;

    if (clip === undefined || media === undefined) return;

    loading?.abort();

    const controller = new AbortController();
    const { signal } = controller;

    const start = Math.floor(from);
    const total = toSeconds(clip.end) - toSeconds(clip.begin);

    loading = controller;
    loadStart = start;
    // In the video's time, as the seeks it's checked against are
    loadingFrom = start / view.speedUp;

    try {
      const response = await fetch(
        clipUrl(
          { ...clip, begin: fromSeconds(toSeconds(clip.begin) + start) },
          false,
          view,
        ),
        { signal },
      );

      if (!response.ok || response.body === null) {
        throw new Error(`The server answered ${response.status}`);
      }

      events.onLoad();

      const reader = response.body.getReader();
      let target: SourceBuffer | undefined;
      let head = new Uint8Array(0);

      for (;;) {
        const { done, value } = await reader.read();

        if (done || signal.aborted) break;

        if (target === undefined) {
          // Held until the MP4's header says which codec it is
          const joined = new Uint8Array(head.length + value.length);

          joined.set(head);
          joined.set(value, head.length);
          head = joined;

          const type = typeOf(head);

          if (type === undefined && head.length < headLimit) continue;

          target = await bufferFor(media, type ?? avcType);

          if (signal.aborted || source !== media) return;

          // A new MP4 starts here: reset the parser and place its time at `start`
          if (media.readyState === "open") target.abort();

          target.timestampOffset = start / view.speedUp;
          await append(target, signal, head);
          continue;
        }

        await append(target, signal, value);
      }

      if (signal.aborted) return;

      loading = undefined;

      // The whole clip is in: let the video end there. Short of that the
      // download was cut off, or stopped where the recordings change codec:
      // "waiting" picks it up again, or here when the playhead is already
      // at the end of what's loaded
      if (loadedUntil() >= (total - 3) / view.speedUp) {
        if (target !== undefined && media.readyState === "open") {
          await settle(target);
          media.endOfStream();
        }
      } else if (!isLoaded(video.currentTime)) {
        resume();
      }
    } catch (error) {
      if (signal.aborted) return;

      loading = undefined;
      events.onProblem(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * The source buffer for an MP4 of `type`, changing the one there is to it
   * where they differ, such as at a camera's older H.264 recordings. A
   * browser that can't play it, as many can't play H.265, says so.
   */
  const bufferFor = async (media: MediaSource, type: string) => {
    if (!MediaSource.isTypeSupported(type)) {
      throw new Error(
        type === hevcType
          ? "This browser can't play H.265 video. Download the recording to play it in another player, or open Kestrel in a browser that plays H.265, such as Chrome, Edge or Safari."
          : "This browser can't play this video.",
      );
    }

    const existing = buffer;

    if (existing === undefined) {
      const created = media.addSourceBuffer(type);

      buffer = created;
      bufferType = type;

      return created;
    }

    await settle(existing);

    if (bufferType !== type) {
      existing.changeType(type);
      bufferType = type;
    }

    return existing;
  };

  /**
   * Loads on from the end of what's loaded. A load that got no further, such
   * as one that stopped where a camera's recordings change codec, goes on
   * from the next second instead.
   */
  const resume = () => {
    const until = loadedUntil() * view.speedUp;

    void load(Math.floor(until) <= loadStart ? Math.ceil(until + 0.5) : until);
  };

  /** Whether the load under way starts at or just before `time`, so will reach it soon. */
  const isComing = (time: number) =>
    loading !== undefined &&
    loadingFrom <= time &&
    time < loadingFrom + loadReach;

  video.addEventListener("seeking", () => {
    const time = video.currentTime;

    if (current !== undefined && !isLoaded(time) && !isComing(time)) {
      void load(time * view.speedUp);
    }
  });

  video.addEventListener("ended", () => {
    if (current !== undefined) events.onEnded(current);
  });

  video.addEventListener("waiting", () => {
    if (
      current !== undefined &&
      loading === undefined &&
      !isLoaded(video.currentTime)
    ) {
      resume();
    }
  });

  const stop = () => {
    loading?.abort();
    loading = undefined;
    current = undefined;
    source = undefined;
    buffer = undefined;
    bufferType = "";
    loadStart = -1;
    video.removeAttribute("src");
    video.load();

    if (objectUrl !== "") URL.revokeObjectURL(objectUrl);

    objectUrl = "";
  };

  const play = async (clip: Clip, from = 0, autoplay = true) => {
    stop();

    // Inside the clip, even from a position kept for a longer one
    const length = toSeconds(clip.end) - toSeconds(clip.begin);

    const start = Math.min(
      Math.max(0, Math.floor(from)),
      Math.max(length - 2, 0),
    );

    current = clip;

    // Without Media Source Extensions, such as on an iPhone, the browser
    // plays the MP4 as it arrives, seeking only within what has loaded. The
    // MP4 starts at `from`, so the video's time runs from there
    if (
      typeof MediaSource === "undefined" ||
      !MediaSource.isTypeSupported(avcType)
    ) {
      base = start;
      video.src = clipUrl(
        { ...clip, begin: fromSeconds(toSeconds(clip.begin) + start) },
        false,
        view,
      );

      if (autoplay) await video.play().catch(() => undefined);

      return;
    }

    base = 0;

    const media = new MediaSource();

    source = media;
    objectUrl = URL.createObjectURL(media);
    video.src = objectUrl;
    await once(media, "sourceopen");

    if (source !== media) return;

    media.duration = length / view.speedUp;

    // The source buffer comes with the first load, once its MP4 says which
    // codec it is. With no video yet this only sets where playback starts,
    // once the first fragment arrives; the load from there is already coming
    if (start > 0) video.currentTime = start / view.speedUp;

    void load(start);

    if (autoplay) await video.play().catch(() => undefined);
  };

  /** Seconds into the clip at the playhead. */
  const offset = () => base + video.currentTime * view.speedUp;

  return {
    play,
    stop,
    seek: (to) => {
      const clip = current;

      if (clip === undefined) return;

      // Before where the MP4 starts there's nothing to seek to, so it
      // starts again from there
      if (to < base) {
        void play(clip, to);

        return;
      }

      video.currentTime = (to - base) / view.speedUp;
    },
    view: (next) => {
      if (sameView(next, view)) return;

      const clip = current;
      const at = clip === undefined ? 0 : offset();
      const playing = !video.paused;

      view = next;

      if (clip !== undefined) void play(clip, at, playing);
    },
    clip: () => current,
    offset: () => (current === undefined ? undefined : offset()),
    time: () =>
      current === undefined
        ? undefined
        : fromSeconds(toSeconds(current.begin) + Math.floor(offset())),
  };
};
