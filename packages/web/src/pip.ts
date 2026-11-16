/**
 * Picture in picture for a live camera: its player leaves the page for the
 * browser's floating window and keeps playing there, whatever the app does
 * after, on any page, paused or not and with the tab in the background,
 * until the window's closed. One camera at a time; recordings don't go
 * there.
 */
import type { Camera } from "@timmo001/kestrel-core";

/** What it uses of go2rtc's player. */
export interface PipPlayer extends HTMLElement {
  /** Keeps the stream open while the page is hidden. */
  background: boolean;
  /** Closes the stream, without reconnecting. */
  ondisconnect: () => void;
}

/** A camera's sound: whether it's on and how loud, from 0 to 100. */
export interface PipSound {
  readonly on: boolean;
  readonly volume: number;
}

/** How long a player that's only starting has to show its first frame. */
const startWait = 5000;

/** Whether the browser has picture in picture for video. */
export const pipEnabled = () =>
  "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;

/** The camera in the window, and the player that plays it. */
let current:
  { readonly camera: Camera["id"]; readonly player: PipPlayer } | undefined;

const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of listeners) listener();
};

/** Calls `listener` each time a camera goes into the window or comes out. */
export const onPipChange = (listener: () => void) => {
  listeners.add(listener);
};

/** The camera in the window, if there's one. */
export const pipCamera = () => current?.camera;

/** Where the players in the window wait, once it's made. */
let hostElement: HTMLElement | undefined;

/**
 * Where the players in the window wait, out of sight: on the page, so they
 * play, but never in a page's way, and never taken off with one.
 */
const host = () => {
  if (hostElement !== undefined) return hostElement;

  hostElement = document.createElement("div");
  hostElement.className = "pip-host";
  hostElement.setAttribute("aria-hidden", "true");
  document.body.append(hostElement);

  return hostElement;
};

const videoOf = (player: PipPlayer) => player.querySelector("video");

/** Closes a player's stream and takes it off the page. */
const drop = (player: PipPlayer) => {
  player.ondisconnect();
  player.remove();

  if (current?.player !== player) return;

  current = undefined;
  changed();
};

/** Waits for a video's first frame, up to `startWait`; false if it never came. */
const started = (video: HTMLVideoElement) =>
  video.readyState >= HTMLMediaElement.HAVE_METADATA
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), startWait);

        video.addEventListener(
          "loadedmetadata",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });

/**
 * Shows `camera` in the window from `player`, one playing already or one
 * still to start, which it takes off the page it was on. Whichever camera
 * was there before closes. False where the browser wouldn't open it, such
 * as when a slow stream took too long after the press.
 */
export const openPip = async (
  camera: Camera["id"],
  player: PipPlayer,
  sound: PipSound,
) => {
  // Moved in one go, so the video never stops between the two places
  player.removeAttribute("style");
  player.removeAttribute("class");
  player.background = true;
  host().append(player);

  const video = videoOf(player);

  if (video === null || !(await started(video))) {
    drop(player);

    return false;
  }

  video.controls = false;
  video.muted = !sound.on;
  video.volume = sound.volume / 100;

  // Played after a pause in the window, it goes back to now, not on from
  // where it stopped
  video.addEventListener("play", () => {
    const { seekable } = video;

    if (seekable.length > 0)
      video.currentTime = seekable.end(seekable.length - 1);
  });

  video.addEventListener("leavepictureinpicture", () => drop(player), {
    once: true,
  });

  try {
    await video.requestPictureInPicture();
  } catch {
    drop(player);

    return false;
  }

  const before = current;

  current = { camera, player };

  if (before !== undefined && before.player !== player) drop(before.player);

  changed();

  return true;
};

/** Closes the window, which takes its player off the page. */
export const closePip = async () => {
  if (document.pictureInPictureElement !== null) {
    await document.exitPictureInPicture();
  }
};

/** A camera's sound in the window, as it changes on the page. */
export const setPipSound = (camera: Camera["id"], sound: PipSound) => {
  const video = current?.camera === camera ? videoOf(current.player) : null;

  if (video === null) return;

  video.muted = !sound.on;
  video.volume = sound.volume / 100;
};
