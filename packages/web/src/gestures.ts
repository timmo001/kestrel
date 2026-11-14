/**
 * Swipes on a player's picture, for touch screens: one or more fingers moving
 * the same way far enough, rather than pinching, or dragging something a drag
 * already moves, such as a zoomed picture or a camera being steered. A
 * player's stage has one recogniser, which its controls and its page both
 * listen to, and a swipe it takes does nothing else, such as a click.
 */

/** Which way a swipe went. */
export type Direction = "up" | "down" | "left" | "right";

export interface Swipe {
  /** How many fingers swiped, together. */
  readonly fingers: number;
  readonly direction: Direction;
}

/** How far the fingers move, in pixels, before it's a swipe. */
const swipeDistance = 48;

/** How much two fingers may spread or close before it's a pinch instead. */
const pinchSlack = 40;

/** What a drag already moves: a zoomed picture, a camera being steered, or a control. */
const draggable =
  "[data-movable], [data-steering], .player-controls, .live-steer-dock, gw-range, gw-popover";

interface Finger {
  readonly x0: number;
  readonly y0: number;
  x: number;
  y: number;
}

const listeners = new WeakMap<HTMLElement, Set<(swipe: Swipe) => void>>();

const spread = (fingers: ReadonlyArray<Finger>, at: "start" | "end") => {
  const [a, b] = fingers;

  if (a === undefined || b === undefined) return 0;

  return at === "start"
    ? Math.hypot(a.x0 - b.x0, a.y0 - b.y0)
    : Math.hypot(a.x - b.x, a.y - b.y);
};

/** The swipe the fingers made, if they made one. */
const swipeOf = (fingers: ReadonlyArray<Finger>): Swipe | undefined => {
  if (fingers.length === 0) return undefined;

  if (
    fingers.length > 1 &&
    Math.abs(spread(fingers, "end") - spread(fingers, "start")) > pinchSlack
  ) {
    return undefined;
  }

  const dx =
    fingers.reduce((sum, finger) => sum + finger.x - finger.x0, 0) /
    fingers.length;

  const dy =
    fingers.reduce((sum, finger) => sum + finger.y - finger.y0, 0) /
    fingers.length;

  const across = Math.abs(dx);
  const down = Math.abs(dy);

  if (Math.max(across, down) < swipeDistance) return undefined;

  if (down > 2 * across) {
    return { fingers: fingers.length, direction: dy < 0 ? "up" : "down" };
  }

  if (across > 2 * down) {
    return { fingers: fingers.length, direction: dx < 0 ? "left" : "right" };
  }

  return undefined;
};

/** Starts the recogniser on a stage, the first time something listens. */
const recognise = (stage: HTMLElement, heard: Set<(swipe: Swipe) => void>) => {
  const down = new Map<number, Finger>();
  let fingers: Array<Finger> = [];
  /** Whether this touch can't be a swipe: it began on something a drag moves, or the browser took it. */
  let spoilt = false;
  /** Whether a swipe just ended, so the click that follows does nothing. */
  let swiped = false;

  stage.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch") return;

      if (down.size === 0) {
        fingers = [];
        spoilt = false;
      }

      if (
        event
          .composedPath()
          .some(
            (target) => target instanceof Element && target.matches(draggable),
          )
      ) {
        spoilt = true;
      }

      const finger = {
        x0: event.clientX,
        y0: event.clientY,
        x: event.clientX,
        y: event.clientY,
      };

      down.set(event.pointerId, finger);
      fingers.push(finger);
    },
    true,
  );

  stage.addEventListener(
    "pointermove",
    (event) => {
      const finger = down.get(event.pointerId);

      if (finger === undefined) return;

      finger.x = event.clientX;
      finger.y = event.clientY;
    },
    true,
  );

  const lift = (event: PointerEvent) => {
    if (!down.has(event.pointerId)) return;

    if (event.type === "pointercancel") spoilt = true;

    down.delete(event.pointerId);

    if (down.size > 0 || spoilt) return;

    const swipe = swipeOf(fingers);

    if (swipe === undefined) return;

    swiped = true;
    setTimeout(() => {
      swiped = false;
    }, 400);

    for (const listener of heard) listener(swipe);
  };

  stage.addEventListener("pointerup", lift, true);
  stage.addEventListener("pointercancel", lift, true);

  // A swipe's lift doesn't also press what it ended on
  for (const type of ["click", "dblclick"]) {
    stage.addEventListener(
      type,
      (event) => {
        if (swiped) event.stopPropagation();
      },
      true,
    );
  }
};

/**
 * Calls `listener` with each swipe on `stage`, a player's stage: one
 * finger's to show or hide its controls or move on, three fingers' for help.
 */
export const onSwipe = (
  stage: HTMLElement,
  listener: (swipe: Swipe) => void,
) => {
  const heard = listeners.get(stage);

  if (heard !== undefined) {
    heard.add(listener);

    return;
  }

  const fresh = new Set([listener]);

  listeners.set(stage, fresh);
  recognise(stage, fresh);
};
