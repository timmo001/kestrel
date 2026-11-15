/**
 * The playback timeline under the player, as camera apps have it: a line
 * fixed in the middle is the playhead, and the day moves under it. A drag
 * or a scroll scrubs, the video following where it's already loaded, and
 * plays from where it lets go; a click or tap jumps there; ‹ and › step
 * along by most of a view; a pinch or Ctrl and the wheel zoom from the whole
 * day down to a minute. Wherever it lands snaps to the nearest recording. A
 * track per channel when several play. It only draws; what plays is the
 * page's to decide.
 */
import { scrollButtons } from "@timmo001/groundwork-ui/scroll-buttons.ts";

/** Whether the person asked for reduced motion. */
const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A recording on the timeline, in seconds of its day. */
export interface TimelineSpan {
  readonly start: number;
  readonly end: number;
  /** Which colour it takes, as the table's chips: neutral, info, warning or important. */
  readonly tone: string;
  readonly title: string;
  /** Drawn faded, for a recording that's listed but can't be played. */
  readonly muted?: boolean;
}

/** One channel's track: its name, shown when there are several, and its recordings. */
export interface TimelineRow {
  readonly label: string;
  readonly spans: ReadonlyArray<TimelineSpan>;
  /** Shimmering, for a camera whose recordings are still coming. */
  readonly loading?: boolean;
}

export interface TimelineElements {
  /** Holds what follows, so the playhead and the steps sit over the track. */
  readonly frame: HTMLElement;
  /** What scrolls, and what's dragged. */
  readonly track: HTMLElement;
  /** The day inside it, sized to the zoom, with half a view either side. */
  readonly day: HTMLElement;
  /** Holds the recordings, clipped to the bar. */
  readonly spans: HTMLElement;
  /** The tracks' names, which stay put as the day moves. */
  readonly labels: HTMLElement;
  /** The line fixed in the middle. */
  readonly playhead: HTMLElement;
  /** The line and time under the pointer. */
  readonly hover: HTMLElement;
  /** The stretch marked for a clip. */
  readonly clip: HTMLElement;
  /** The time labels under the bar. */
  readonly ticks: HTMLElement;
  /** The buttons that step back or on by most of a view. */
  readonly earlier: HTMLElement;
  readonly later: HTMLElement;
}

export interface Timeline {
  /** Draws a day's recordings, a track per row, in place of the last day's. */
  readonly show: (rows: ReadonlyArray<TimelineRow>) => void;
  /** Moves the day so the playhead's second is in the middle, or marks none playing. */
  readonly playhead: (second: number | undefined) => void;
  /** Shows the stretch marked for a clip, or hides it. */
  readonly clip: (from: number | undefined, to: number | undefined) => void;
  /** How many seconds the bar shows, from a whole day down, around the middle. */
  readonly zoom: (seconds: number) => void;
  /** Zooms in (above 1) or out (below 1) by a factor, around the middle. */
  readonly zoomBy: (factor: number) => void;
}

export interface TimelineOptions {
  /** Hears the second of the day it lands on, snapped, to play from there. */
  readonly onPick: (second: number) => void;
  /** Hears the second in the middle as a drag or scroll moves it, before it lands. */
  readonly onScrub?: (second: number) => void;
  /** What it snaps to, such as only the events; every recording that plays otherwise. */
  readonly targets?: () => ReadonlyArray<Snap> | undefined;
  /** Hears how many seconds the bar shows, as it zooms. */
  readonly onZoom?: (seconds: number) => void;
}

const daySeconds = 24 * 60 * 60;

/** The closest the bar zooms in, in seconds across it. */
export const minimumSpan = 60;

/** How far a press moves before it's a drag rather than a click, in pixels. */
const dragAfter = 4;

/** How long a scroll is quiet before it's landed, in milliseconds. */
const settleAfter = 150;

/** How long after a wheel, press or key a scroll counts as the person's, in milliseconds. */
const gestureReach = 1000;

/** Seconds of the day as `HH:MM:SS`. */
export const clockOf = (second: number) =>
  [second / 3600, (second / 60) % 60, second % 60]
    .map((part) => String(Math.floor(part)).padStart(2, "0"))
    .join(":");

/** About how wide each label needs, with room either side. */
const tickWidth = 56;

/** The gap between labels for a span, so `fit` labels or fewer fit across. */
const tickStep = (span: number, fit: number) =>
  [60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600].find(
    (step) => span / step <= fit,
  ) ?? 21_600;

/** How many labels fit across `width` pixels, up to eight. */
const labelsAcross = (width: number) =>
  Math.min(8, Math.max(2, Math.floor(width / tickWidth)));

/** Where a press lands, in seconds of the day, and what it can snap to. */
export interface Snap {
  readonly start: number;
  readonly end: number;
}

/**
 * How far before the end of one behind a landing goes, in seconds. Its last
 * second would play out at once and carry on to the next, back where the
 * press or drag came from.
 */
const behindLead = 30;

/** Where a landing behind `target` plays from: its last stretch, or its start when it's short. */
const lastStretch = (target: Snap) =>
  Math.max(target.start, Math.ceil(target.end) - behindLead);

/**
 * The second a press at `second` picks among `targets`: in one, that
 * second; off every one, the nearest one, its start ahead or its last
 * stretch behind, however far, so a press needn't be exact; with none, the
 * second itself.
 */
export const snapTo = (second: number, targets: ReadonlyArray<Snap>) =>
  targets
    .map((target) => {
      if (second < target.start) {
        return { at: target.start, off: target.start - second };
      }

      if (second >= target.end) {
        return { at: lastStretch(target), off: second - target.end };
      }

      return { at: second, off: 0 };
    })
    .reduce<{ at: number; off: number } | undefined>(
      (best, one) => (best === undefined || one.off < best.off ? one : best),
      undefined,
    )?.at ?? second;

/**
 * As `snapTo`, but only toward `toward`: the latest point at or before
 * `second` for `start`, the earliest at or after it for `end`, so a step or
 * a drag that lands in a gap never goes back where it came from. With
 * nothing that way, the nearest point either way.
 */
export const snapToward = (
  second: number,
  targets: ReadonlyArray<Snap>,
  toward: "start" | "end",
) => {
  const points = targets.flatMap((target) => {
    if (toward === "start") {
      if (target.start > second) return [];

      return [second < target.end ? second : lastStretch(target)];
    }

    return target.end > second ? [Math.max(second, target.start)] : [];
  });

  if (points.length === 0) return snapTo(second, targets);

  return toward === "start" ? Math.max(...points) : Math.min(...points);
};

/** A span of seconds in words, such as `Day`, `4 h` or `25 min`. */
export const spanLabel = (seconds: number) => {
  if (seconds >= daySeconds) return "Day";

  if (seconds >= 3600) {
    const hours = Math.round((seconds / 3600) * 10) / 10;

    return `${hours} h`;
  }

  return `${Math.max(1, Math.round(seconds / 60))} min`;
};

const dayPercent = (second: number) => `${(second / daySeconds) * 100}%`;

/** A timeline over `elements`, calling back as `options` asks. */
export const timelineFor = (
  elements: TimelineElements,
  options: TimelineOptions,
): Timeline => {
  const { onPick, onScrub, targets, onZoom } = options;
  const { track } = elements;
  let rows: ReadonlyArray<TimelineRow> = [];
  let span = daySeconds;
  /** The second in the middle, under the playhead. */
  let centre = daySeconds / 2;
  let head: number | undefined;
  let fit = 8;
  let drawnStep = 0;
  /** Pixels a second, at this zoom and width. */
  let scale = 0;
  /**
   * What's moving the day: only the playhead, a drag, the person's own
   * scroll, a pinch, or a glide to where a press landed.
   */
  let mode: "idle" | "drag" | "scroll" | "pinch" | "glide" = "idle";
  /** Whether the person has moved it, so new recordings don't move it back. */
  let moved = false;
  /** Where it last scrolled itself, to tell its own scrolls from the person's. */
  let own = -1;
  /** When the person last used a wheel, a press or a key on it. */
  let gestureAt = Number.NEGATIVE_INFINITY;
  let settling: ReturnType<typeof setTimeout> | undefined;

  const held = (second: number) => Math.min(Math.max(second, 0), daySeconds);

  /** Scrolls so `second` is in the middle, at once. */
  const centreOn = (second: number) => {
    centre = held(second);
    track.scrollLeft = centre * scale;
    own = track.scrollLeft;
  };

  const drawTicks = () => {
    const step = tickStep(span, fit);

    if (step === drawnStep) return;

    drawnStep = step;

    const ticks: Array<HTMLElement> = [];

    for (let second = 0; second <= daySeconds; second += step) {
      const tick = document.createElement("span");

      tick.textContent = clockOf(second).slice(0, 5);
      tick.style.left = dayPercent(second);
      ticks.push(tick);
    }

    elements.ticks.replaceChildren(...ticks);
  };

  /** Sizes the day to the zoom and the width, keeping the middle where it is. */
  const layout = () => {
    const width = track.clientWidth;

    if (width === 0) return;

    scale = width / span;
    elements.frame.style.setProperty("--timeline-half", `${width / 2}px`);
    elements.frame.style.setProperty(
      "--timeline-day",
      `${daySeconds * scale}px`,
    );
    drawTicks();
    centreOn(centre);
  };

  const drawRows = () => {
    elements.frame.style.setProperty("--timeline-rows", String(rows.length));

    elements.spans.replaceChildren(
      ...rows.map((row, index) => {
        const band = document.createElement("div");

        band.className = "timeline-row";
        band.toggleAttribute("data-loading", row.loading === true);
        band.style.top = `${(index / rows.length) * 100}%`;
        band.style.height = `${100 / rows.length}%`;

        band.append(
          ...row.spans.map((recording) => {
            const bar = document.createElement("span");

            bar.className = "timeline-span";
            bar.dataset.tone = recording.tone;
            bar.toggleAttribute("data-muted", recording.muted === true);
            bar.title = recording.title;
            bar.style.left = dayPercent(recording.start);
            bar.style.width = dayPercent(recording.end - recording.start);

            return bar;
          }),
        );

        return band;
      }),
    );

    // Named only when there's more than one to tell apart, over the start
    elements.labels.replaceChildren(
      ...(rows.length > 1 ? rows : []).map((row, index) => {
        const name = document.createElement("span");

        name.className = "timeline-row-label";
        name.textContent = row.label;
        name.style.top = `${((index + 0.5) / rows.length) * 100}%`;

        return name;
      }),
    );
  };

  const snaps = () =>
    targets?.() ??
    rows.flatMap((row) => row.spans.filter((each) => each.muted !== true));

  /**
   * The second a landing at `second` picks: the nearest target, or after a
   * move, the nearest the way it moved.
   */
  const pickFor = (second: number, toward?: "start" | "end") => {
    const at = Math.min(Math.floor(second), daySeconds - 1);

    return toward === undefined
      ? snapTo(at, snaps())
      : snapToward(at, snaps(), toward);
  };

  /** Where the middle was as the day began to move, to know which way it went. */
  let movedFrom: number | undefined;

  const startMove = () => {
    movedFrom ??= centre;
  };

  /** The second of the day under a pointer's x. */
  const secondAt = (x: number) => {
    const box = track.getBoundingClientRect();

    return scale === 0
      ? centre
      : held(centre + (x - box.left - box.width / 2) / scale);
  };

  /** The time in the middle, over the playhead, while it's scrubbed. */
  const showScrub = (on: boolean) => {
    elements.playhead.toggleAttribute("data-scrubbing", on);

    if (on) elements.playhead.dataset.time = clockOf(Math.floor(centre));
  };

  /** Settles to idle once it's quiet, as a glide ends. */
  let land: () => void = () => undefined;

  const settleLater = () => {
    clearTimeout(settling);
    settling = setTimeout(() => {
      settling = undefined;

      if (mode === "scroll") land();
      else if (mode === "glide") {
        mode = "idle";
        own = track.scrollLeft;
      }
    }, settleAfter);
  };

  /** Moves `second` to the middle smoothly, or at once under reduced motion. */
  const glideTo = (second: number) => {
    const left = held(second) * scale;

    if (reducedMotion() || Math.abs(left - track.scrollLeft) < 1) {
      mode = "idle";
      centreOn(second);

      return;
    }

    mode = "glide";
    centre = held(second);
    track.scrollTo({ left, behavior: "smooth" });
    settleLater();
  };

  // Plays from the second in the middle, snapped, and glides it there
  land = () => {
    showScrub(false);

    const from = movedFrom;

    movedFrom = undefined;

    const second = pickFor(
      centre,
      from === undefined || from === centre
        ? undefined
        : centre < from
          ? "start"
          : "end",
    );

    onPick(second);
    glideTo(second);
  };

  /** Zooms to `next` seconds across, around the middle. */
  const zoomTo = (next: number) => {
    const before = span;

    span = Math.min(Math.max(next, minimumSpan), daySeconds);

    if (span === before) return;

    layout();
    onZoom?.(span);
  };

  track.addEventListener(
    "scroll",
    () => {
      const ours = Math.abs(track.scrollLeft - own) < 1;

      // The person's only straight after their own wheel, press or key, so
      // a scroll the page causes never plays anything
      if (mode === "idle") {
        if (ours || performance.now() - gestureAt > gestureReach) return;

        startMove();
        mode = "scroll";
      }

      if (scale > 0) centre = held(track.scrollLeft / scale);

      if (mode === "glide" || mode === "scroll") settleLater();

      if (mode === "drag" || mode === "scroll") {
        moved = true;
        elements.hover.hidden = true;
        showScrub(true);
        onScrub?.(centre);
      }
    },
    { passive: true },
  );

  const gesture = () => {
    gestureAt = performance.now();
  };

  // A click too, for ‹ and › pressed from a keyboard
  for (const type of ["wheel", "keydown", "pointerdown", "click"]) {
    elements.frame.addEventListener(type, gesture, {
      capture: true,
      passive: true,
    });
  }

  /** A press that may become a drag: where it began, and how fast it's going. */
  let press:
    | {
        x: number;
        left: number;
        dragged: boolean;
        last: { x: number; at: number };
        speed: number;
      }
    | undefined;

  /** The fingers on the bar, for a pinch, by pointer. */
  const fingers = new Map<number, number>();

  /** A pinch under way: the span and the fingers' spread it began at. */
  let pinch: { span: number; spread: number } | undefined;

  const spreadOf = () => {
    const [a = 0, b = 0] = [...fingers.values()];

    return Math.abs(a - b);
  };

  const showHover = (x: number) => {
    const second = pickFor(secondAt(x));
    const width = track.clientWidth;
    const left = width / 2 + (second - centre) * scale;

    elements.hover.hidden = left < 0 || left > width;
    elements.hover.style.left = `${left}px`;
    elements.hover.dataset.time = clockOf(second);
  };

  track.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    if (event.pointerType === "touch")
      fingers.set(event.pointerId, event.clientX);

    // A second finger makes it a pinch, not a drag or a click
    if (fingers.size === 2) {
      press = undefined;
      mode = "pinch";
      pinch = { span, spread: Math.max(spreadOf(), 1) };
      showScrub(false);

      return;
    }

    clearTimeout(settling);
    press = {
      x: event.clientX,
      left: track.scrollLeft,
      dragged: false,
      last: { x: event.clientX, at: event.timeStamp },
      speed: 0,
    };
    track.setPointerCapture(event.pointerId);
  });

  track.addEventListener("pointermove", (event) => {
    if (fingers.has(event.pointerId)) {
      fingers.set(event.pointerId, event.clientX);
    }

    if (pinch !== undefined && fingers.size === 2) {
      zoomTo((pinch.span * pinch.spread) / Math.max(spreadOf(), 1));

      return;
    }

    if (press !== undefined) {
      const moved = event.clientX - press.x;

      if (!press.dragged && Math.abs(moved) > dragAfter) {
        press.dragged = true;
        startMove();
        mode = "drag";
      }

      if (press.dragged) {
        const gap = event.timeStamp - press.last.at;

        if (gap > 0) press.speed = (event.clientX - press.last.x) / gap;

        press.last = { x: event.clientX, at: event.timeStamp };
        track.scrollLeft = press.left - moved;

        return;
      }
    }

    if (event.pointerType === "mouse") showHover(event.clientX);
  });

  track.addEventListener("pointerup", (event) => {
    fingers.delete(event.pointerId);

    if (pinch !== undefined) {
      if (fingers.size === 0) {
        pinch = undefined;
        mode = "idle";
        own = track.scrollLeft;
      }

      return;
    }

    const pressed = press;

    press = undefined;

    if (pressed === undefined) return;

    // A click or tap jumps there
    if (!pressed.dragged) {
      const second = pickFor(secondAt(event.clientX));

      moved = true;
      elements.hover.hidden = true;
      onPick(second);
      glideTo(second);

      return;
    }

    // A flick carries on a little, as a scroll does, then lands
    const flick =
      event.timeStamp - pressed.last.at < 80 && Math.abs(pressed.speed) > 0.3;

    mode = "scroll";

    if (flick && !reducedMotion()) {
      track.scrollBy({ left: -pressed.speed * 300, behavior: "smooth" });
      settleLater();

      return;
    }

    land();
  });

  track.addEventListener("pointercancel", (event) => {
    fingers.delete(event.pointerId);
    press = undefined;

    if (pinch !== undefined && fingers.size === 0) {
      pinch = undefined;
      mode = "idle";
    } else if (mode === "drag") {
      mode = "scroll";
      land();
    }
  });

  track.addEventListener("pointerleave", () => {
    elements.hover.hidden = true;
  });

  // Ctrl or ⌘ and the wheel, as a trackpad's pinch sends it, zooms around
  // the middle; across, or with Shift, it scrolls; the wheel alone scrolls
  // the page
  track.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;

      event.preventDefault();
      // A mouse's notch is a big step and a trackpad's pinch many small
      // ones, so each is held to at most about half again or a third less
      zoomTo(span * Math.exp(Math.min(Math.max(event.deltaY, -40), 40) * 0.01));
    },
    { passive: false },
  );

  // ‹ and ›, each shown while there's more of the day its way; a press moves
  // the day as a drag does, so the playhead doesn't pull it back, and it
  // plays from where it lands
  scrollButtons(track, {
    start: elements.earlier,
    end: elements.later,
    items: () => [elements.day],
  });

  for (const step of [elements.earlier, elements.later]) {
    step.addEventListener("click", () => {
      startMove();
      mode = "scroll";
      settleLater();
    });
  }

  // Fewer labels on a narrow bar, such as a phone's, so they don't run
  // together, and the day sized again to the width
  new ResizeObserver(() => {
    fit = labelsAcross(track.clientWidth);
    layout();
  }).observe(track);

  return {
    show: (next) => {
      rows = next;
      drawRows();

      // Nothing playing and not moved yet: the middle of the day's recordings
      if (head === undefined && !moved && mode === "idle") {
        const spans = rows.flatMap((row) => row.spans);

        if (spans.length > 0) {
          const first = Math.min(...spans.map((each) => each.start));
          const last = Math.max(...spans.map((each) => each.end));

          centreOn((first + last) / 2);
        }
      }
    },
    playhead: (second) => {
      head = second;
      elements.playhead.toggleAttribute("data-idle", second === undefined);

      // The day follows the playhead, unless the person is moving it
      if (second !== undefined && mode === "idle") centreOn(second);
    },
    clip: (from, to) => {
      const marked = from !== undefined && to !== undefined && to > from;

      elements.clip.hidden = !marked;

      if (marked) {
        elements.clip.style.left = dayPercent(from);
        elements.clip.style.width = dayPercent(to - from);
      }
    },
    zoom: (seconds) => {
      zoomTo(seconds);
    },
    zoomBy: (factor) => {
      zoomTo(span / factor);
    },
  };
};
