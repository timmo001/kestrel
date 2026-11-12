/**
 * The recordings player. It plays the server's MP4 of a recording through
 * Media Source Extensions rather than a plain video source: the length is
 * known from the start, a seek past what's loaded asks the server for video
 * from there, and only a few minutes around the playhead stay in memory, as
 * the recorder sends far faster than it plays.
 */

/** A stretch of one channel's recording, in recorder times. */
export interface Clip {
  readonly channel: number;
  readonly begin: string;
  readonly end: string;
}

/** A recorder time as seconds since 1970, read as UTC: the recorder keeps no zone. */
export const toSeconds = (time: string) => Date.parse(`${time}Z`) / 1000;

/** Seconds since 1970 as a recorder time. */
export const fromSeconds = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 19);

/** The server's MP4 of a clip, to play or, with `download`, to save as a file. */
export const clipUrl = (clip: Clip, download = false) => {
  const url = new URL("api/recordings/video", location.origin);

  url.searchParams.set("channel", String(clip.channel));
  url.searchParams.set("begin", clip.begin);
  url.searchParams.set("end", clip.end);

  if (download) url.searchParams.set("download", "true");

  return url.href;
};

/** Seconds of video loaded ahead of the playhead before the download waits. */
const ahead = 90;

/** Seconds of video kept behind the playhead, for a short skip back. */
const behind = 30;

/** Any H.264 the recorder sends fits this; the MP4's own header has the exact profile. */
const mimeType = 'video/mp4; codecs="avc1.640028"';

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
   * Plays a clip, from `from` seconds in (its start by default), in place of
   * whatever was playing.
   */
  readonly play: (clip: Clip, from?: number) => Promise<void>;
  /** Stops and lets go of the video. */
  readonly stop: () => void;
  /** What's playing, if anything. */
  readonly clip: () => Clip | undefined;
  /** The recorder time at the playhead. */
  readonly time: () => string | undefined;
}

export interface PlayerEvents {
  /** Why video stopped coming, such as the recorder dropping the download. */
  readonly onProblem: (message: string) => void;
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
  let objectUrl = "";

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
    const target = buffer;

    if (clip === undefined || media === undefined || target === undefined) {
      return;
    }

    loading?.abort();

    const controller = new AbortController();
    const { signal } = controller;

    loading = controller;
    loadingFrom = Math.floor(from);
    await settle(target);

    if (signal.aborted) return;

    // A new MP4 starts here: reset the parser and place its time at `start`
    if (media.readyState === "open") target.abort();

    const start = Math.floor(from);
    const total = toSeconds(clip.end) - toSeconds(clip.begin);

    target.timestampOffset = start;

    try {
      const response = await fetch(
        clipUrl({ ...clip, begin: fromSeconds(toSeconds(clip.begin) + start) }),
        { signal },
      );

      if (!response.ok || response.body === null) {
        throw new Error(`The server answered ${response.status}`);
      }

      const reader = response.body.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done || signal.aborted) break;

        await append(target, signal, value);
      }

      if (signal.aborted) return;

      loading = undefined;

      // The whole clip is in: let the video end there. Short of that the
      // download was cut off, and "waiting" picks it up again
      if (loadedUntil() >= total - 3 && media.readyState === "open") {
        await settle(target);
        media.endOfStream();
      }
    } catch (error) {
      if (signal.aborted) return;

      loading = undefined;
      events.onProblem(error instanceof Error ? error.message : String(error));
    }
  };

  /** Whether the load under way starts at or just before `time`, so will reach it soon. */
  const isComing = (time: number) =>
    loading !== undefined &&
    loadingFrom <= time &&
    time < loadingFrom + loadReach;

  video.addEventListener("seeking", () => {
    const time = video.currentTime;

    if (current !== undefined && !isLoaded(time) && !isComing(time)) {
      void load(time);
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
      void load(loadedUntil());
    }
  });

  const stop = () => {
    loading?.abort();
    loading = undefined;
    current = undefined;
    source = undefined;
    buffer = undefined;
    video.removeAttribute("src");
    video.load();

    if (objectUrl !== "") URL.revokeObjectURL(objectUrl);

    objectUrl = "";
  };

  const play = async (clip: Clip, from = 0) => {
    stop();

    const start = Math.max(0, Math.floor(from));

    // Without Media Source Extensions, such as on an iPhone, the browser
    // plays the MP4 as it arrives, seeking only within what has loaded. It
    // starts at `from`, so the clip does too, to keep its times right
    if (
      typeof MediaSource === "undefined" ||
      !MediaSource.isTypeSupported(mimeType)
    ) {
      current = {
        ...clip,
        begin: fromSeconds(toSeconds(clip.begin) + start),
      };

      video.src = clipUrl(current);
      await video.play().catch(() => undefined);

      return;
    }

    current = clip;

    const media = new MediaSource();

    source = media;
    objectUrl = URL.createObjectURL(media);
    video.src = objectUrl;
    await once(media, "sourceopen");

    if (source !== media) return;

    media.duration = toSeconds(clip.end) - toSeconds(clip.begin);
    buffer = media.addSourceBuffer(mimeType);

    // With no video yet this only sets where playback starts, once the
    // first fragment arrives; the load from there is already coming
    if (start > 0) video.currentTime = start;

    void load(start);
    await video.play().catch(() => undefined);
  };

  return {
    play,
    stop,
    clip: () => current,
    time: () =>
      current === undefined
        ? undefined
        : fromSeconds(toSeconds(current.begin) + Math.floor(video.currentTime)),
  };
};
