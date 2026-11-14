/**
 * The playback timeline under the player: one day's recordings as a bar,
 * a track per channel when several play, zoomed from the whole day down to
 * a minute, as Chrome DevTools' Performance timeline zooms: Ctrl and the
 * wheel or a pinch zoom at the pointer, a drag pans, and while zoomed an
 * overview of the whole day shows where the view is, a drag across it
 * zooming to that stretch and a drag on the view moving it. It follows the
 * playhead, and calls back with the second of the day that's clicked,
 * snapped to the nearest recording. It only draws; what plays is the
 * page's to decide.
 */

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
  /** The bar that's clicked and dragged. */
  readonly track: HTMLElement;
  /** Holds the recordings, clipped to the bar. */
  readonly spans: HTMLElement;
  readonly playhead: HTMLElement;
  /** The line and time under the pointer. */
  readonly hover: HTMLElement;
  /** The stretch marked for a clip. */
  readonly clip: HTMLElement;
  /** The time labels under the bar. */
  readonly ticks: HTMLElement;
  /** The whole day in small while zoomed, where a drag picks what the bar shows. */
  readonly overview: HTMLElement;
}

export interface Timeline {
  /** Draws a day's recordings, a track per row, in place of the last day's. */
  readonly show: (rows: ReadonlyArray<TimelineRow>) => void;
  /** Moves the playhead, or hides it; the view follows it when zoomed. */
  readonly playhead: (second: number | undefined) => void;
  /** Shows the stretch marked for a clip, or hides it. */
  readonly clip: (from: number | undefined, to: number | undefined) => void;
  /** How many seconds the bar shows, from a whole day down, around the playhead. */
  readonly zoom: (seconds: number) => void;
  /** Zooms in (above 1) or out (below 1) by a factor, around the playhead. */
  readonly zoomBy: (factor: number) => void;
}

export interface TimelineOptions {
  /** Hears the second of the day clicked, snapped. */
  readonly onPick: (second: number) => void;
  /** What a click snaps to, such as only the events; every recording that plays otherwise. */
  readonly targets?: () => ReadonlyArray<Snap> | undefined;
  /** Hears how many seconds the bar shows, as it zooms. */
  readonly onZoom?: (seconds: number) => void;
}

const daySeconds = 24 * 60 * 60;

/** The closest the bar zooms in, in seconds across it. */
export const minimumSpan = 60;

/** How far a press moves before it's a drag rather than a click, in pixels. */
const dragAfter = 4;

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
 * The second a press at `second` picks among `targets`: in one, that
 * second; off every one, the nearest point of the nearest one, its start
 * ahead or its last second behind, however far, so a press needn't be
 * exact; with none, the second itself.
 */
export const snapTo = (second: number, targets: ReadonlyArray<Snap>) =>
  targets
    .map((target) => {
      if (second < target.start) {
        return { at: target.start, off: target.start - second };
      }

      if (second >= target.end) {
        return {
          at: Math.max(target.start, Math.ceil(target.end) - 1),
          off: second - target.end,
        };
      }

      return { at: second, off: 0 };
    })
    .reduce<{ at: number; off: number } | undefined>(
      (best, one) => (best === undefined || one.off < best.off ? one : best),
      undefined,
    )?.at ?? second;

/** A span of seconds in words, such as `Day`, `4 h` or `25 min`. */
export const spanLabel = (seconds: number) => {
  if (seconds >= daySeconds) return "Day";

  if (seconds >= 3600) {
    const hours = Math.round((seconds / 3600) * 10) / 10;

    return `${hours} h`;
  }

  return `${Math.max(1, Math.round(seconds / 60))} min`;
};

/** A timeline over `elements`, calling back as `options` asks. */
export const timelineFor = (
  elements: TimelineElements,
  options: TimelineOptions,
): Timeline => {
  const { onPick, targets, onZoom } = options;
  let rows: ReadonlyArray<TimelineRow> = [];
  let span = daySeconds;
  let start = 0;
  let head: number | undefined;
  let marked: readonly [number, number] | undefined;
  let fit = 8;

  const clamp = (value: number) =>
    Math.min(Math.max(value, 0), daySeconds - span);

  const percent = (second: number) => `${((second - start) / span) * 100}%`;

  /** The overview's parts: the day's recordings in small, the view, and a stretch being picked. */
  const overviewSpans = document.createElement("div");
  const overviewView = document.createElement("span");
  const overviewPick = document.createElement("span");

  overviewSpans.className = "timeline-overview-spans";
  overviewView.className = "timeline-overview-view";
  overviewPick.className = "timeline-overview-pick";
  overviewPick.hidden = true;
  elements.overview.append(overviewSpans, overviewView, overviewPick);

  const dayPercent = (second: number) => `${(second / daySeconds) * 100}%`;

  /** Draws the day in small, once per day's recordings. */
  const drawOverview = () => {
    overviewSpans.replaceChildren(
      ...rows.flatMap((row) =>
        row.spans.map((recording) => {
          const bar = document.createElement("span");

          bar.className = "timeline-span";
          bar.dataset.tone = recording.tone;
          bar.toggleAttribute("data-muted", recording.muted === true);
          bar.style.left = dayPercent(recording.start);
          bar.style.width = dayPercent(recording.end - recording.start);

          return bar;
        }),
      ),
    );
  };

  /** Where the view is on the overview, which only shows while zoomed. */
  const showView = () => {
    const zoomed = span < daySeconds;

    elements.overview.hidden = !zoomed;
    overviewView.style.left = dayPercent(start);
    overviewView.style.width = dayPercent(span);
  };

  const place = (element: HTMLElement, second: number | undefined) => {
    element.hidden =
      second === undefined || second < start || second > start + span;

    if (second !== undefined) element.style.left = percent(second);
  };

  const draw = () => {
    elements.track.style.setProperty("--timeline-rows", String(rows.length));

    elements.spans.replaceChildren(
      ...rows.map((row, index) => {
        const band = document.createElement("div");

        band.className = "timeline-row";
        band.toggleAttribute("data-loading", row.loading === true);
        band.style.top = `${(index / rows.length) * 100}%`;
        band.style.height = `${100 / rows.length}%`;

        band.append(
          ...row.spans.flatMap((recording) => {
            if (recording.end < start || recording.start > start + span) {
              return [];
            }

            const bar = document.createElement("span");

            bar.className = "timeline-span";
            bar.dataset.tone = recording.tone;
            bar.toggleAttribute("data-muted", recording.muted === true);
            bar.title = recording.title;
            bar.style.left = percent(recording.start);
            bar.style.width = `${((recording.end - recording.start) / span) * 100}%`;

            return [bar];
          }),
        );

        // Named only when there's more than one to tell apart, over the
        // recordings
        if (rows.length > 1) {
          const name = document.createElement("span");

          name.className = "timeline-row-label";
          name.textContent = row.label;
          band.append(name);
        }

        return band;
      }),
    );

    const step = tickStep(span, fit);
    const ticks: Array<HTMLElement> = [];

    for (
      let second = Math.ceil(start / step) * step;
      second <= start + span;
      second += step
    ) {
      const tick = document.createElement("span");

      const share = (second - start) / span;

      tick.textContent = clockOf(Math.min(second, daySeconds - 1)).slice(0, 5);
      tick.style.left = percent(second);
      // Labels at the ends sit inside the bar rather than half off it
      tick.dataset.edge = share < 0.03 ? "start" : share > 0.97 ? "end" : "";
      ticks.push(tick);
    }

    elements.ticks.replaceChildren(...ticks);
    place(elements.playhead, head);
    showView();

    elements.clip.hidden = marked === undefined;

    if (marked !== undefined) {
      elements.clip.style.left = percent(marked[0]);
      elements.clip.style.width = `${((marked[1] - marked[0]) / span) * 100}%`;
    }
  };

  /** Shows `nextSpan` seconds from `nextStart`, held to the day, and says so. */
  const view = (nextStart: number, nextSpan: number) => {
    const before = span;

    span = Math.min(Math.max(nextSpan, minimumSpan), daySeconds);
    start = clamp(nextStart);
    draw();

    if (span !== before) onZoom?.(span);
  };

  /** Zooms to `nextSpan`, keeping `anchor` where it is across the bar, at `share` of the way. */
  const zoomAround = (nextSpan: number, anchor: number, share: number) => {
    const held = Math.min(Math.max(nextSpan, minimumSpan), daySeconds);

    view(anchor - share * held, held);
  };

  /** The share of the way across the bar a pointer's x is. */
  const shareAt = (x: number) => {
    const box = elements.track.getBoundingClientRect();

    return box.width === 0
      ? 0.5
      : Math.min(Math.max((x - box.left) / box.width, 0), 1);
  };

  /** The second of the day under a pointer's x. */
  const secondAt = (x: number) =>
    Math.min(Math.floor(start + shareAt(x) * span), daySeconds - 1);

  /** The second a press at `x` picks, snapped to the nearest target. */
  const pickAt = (x: number) =>
    snapTo(
      secondAt(x),
      targets?.() ??
        rows.flatMap((row) => row.spans.filter((each) => each.muted !== true)),
    );

  let press: { x: number; start: number; dragged: boolean } | undefined;

  /** The fingers on the bar, for a pinch, by pointer. */
  const fingers = new Map<number, number>();

  /** A pinch under way: the span and the fingers' spread it began at, and the second between them. */
  let pinch: { span: number; spread: number; anchor: number } | undefined;

  const spreadOf = () => {
    const [a = 0, b = 0] = [...fingers.values()];

    return Math.abs(a - b);
  };

  const middleOf = () => {
    const [a = 0, b = 0] = [...fingers.values()];

    return (a + b) / 2;
  };

  elements.track.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch")
      fingers.set(event.pointerId, event.clientX);

    // A second finger makes it a pinch, not a drag or a click
    if (fingers.size === 2) {
      press = undefined;
      pinch = {
        span,
        spread: Math.max(spreadOf(), 1),
        anchor: start + shareAt(middleOf()) * span,
      };

      return;
    }

    press = { x: event.clientX, start, dragged: false };
    elements.track.setPointerCapture(event.pointerId);
  });

  elements.track.addEventListener("pointermove", (event) => {
    if (fingers.has(event.pointerId)) {
      fingers.set(event.pointerId, event.clientX);
    }

    if (pinch !== undefined && fingers.size === 2) {
      zoomAround(
        (pinch.span * pinch.spread) / Math.max(spreadOf(), 1),
        pinch.anchor,
        shareAt(middleOf()),
      );

      return;
    }

    if (press !== undefined && span < daySeconds) {
      const moved = event.clientX - press.x;

      if (Math.abs(moved) > dragAfter) press.dragged = true;

      if (press.dragged) {
        const width = elements.track.getBoundingClientRect().width;

        start = clamp(press.start - (moved / width) * span);
        draw();
      }
    }

    const second = pickAt(event.clientX);

    elements.hover.hidden = press?.dragged === true;
    elements.hover.style.left = percent(second);
    elements.hover.dataset.time = clockOf(second);
  });

  elements.track.addEventListener("pointerup", (event) => {
    fingers.delete(event.pointerId);

    if (pinch !== undefined) {
      if (fingers.size === 0) pinch = undefined;

      return;
    }

    const picked = press !== undefined && !press.dragged;

    press = undefined;

    if (picked) onPick(pickAt(event.clientX));
  });

  elements.track.addEventListener("pointercancel", (event) => {
    fingers.delete(event.pointerId);
    press = undefined;

    if (fingers.size === 0) pinch = undefined;
  });

  // Ctrl or ⌘ and the wheel, as a trackpad's pinch sends it, zooms at the
  // pointer; across, or with Shift, it pans; the wheel alone scrolls the page
  elements.track.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        // A mouse's notch is a big step and a trackpad's pinch many small
        // ones, so each is held to at most about half again or a third less
        zoomAround(
          span * Math.exp(Math.min(Math.max(event.deltaY, -40), 40) * 0.01),
          start + shareAt(event.clientX) * span,
          shareAt(event.clientX),
        );

        return;
      }

      const across = event.shiftKey ? event.deltaY : event.deltaX;

      if (across === 0 || span >= daySeconds) return;

      event.preventDefault();

      const width = elements.track.getBoundingClientRect().width;

      view(start + (across / Math.max(width, 1)) * span, span);
    },
    { passive: false },
  );

  // The overview: a drag across it zooms to that stretch, a drag on the view
  // moves it, and a click centres the view there
  let overviewPress:
    { x: number; moved: boolean; onView: boolean; start: number } | undefined;

  const overviewSecond = (x: number) => {
    const box = elements.overview.getBoundingClientRect();

    return box.width === 0
      ? 0
      : Math.min(Math.max((x - box.left) / box.width, 0), 1) * daySeconds;
  };

  elements.overview.addEventListener("pointerdown", (event) => {
    const second = overviewSecond(event.clientX);

    overviewPress = {
      x: event.clientX,
      moved: false,
      onView: second >= start && second <= start + span,
      start,
    };
    elements.overview.setPointerCapture(event.pointerId);
  });

  elements.overview.addEventListener("pointermove", (event) => {
    if (overviewPress === undefined) return;

    if (Math.abs(event.clientX - overviewPress.x) > dragAfter) {
      overviewPress.moved = true;
    }

    if (!overviewPress.moved) return;

    const from = overviewSecond(overviewPress.x);
    const to = overviewSecond(event.clientX);

    if (overviewPress.onView) {
      view(overviewPress.start + (to - from), span);

      return;
    }

    overviewPick.hidden = false;
    overviewPick.style.left = dayPercent(Math.min(from, to));
    overviewPick.style.width = dayPercent(Math.abs(to - from));
  });

  elements.overview.addEventListener("pointerup", (event) => {
    const pressed = overviewPress;

    overviewPress = undefined;
    overviewPick.hidden = true;

    if (pressed === undefined) return;

    const from = overviewSecond(pressed.x);
    const to = overviewSecond(event.clientX);

    if (!pressed.moved) {
      view(to - span / 2, span);
    } else if (!pressed.onView) {
      view(Math.min(from, to), Math.abs(to - from));
    }
  });

  elements.overview.addEventListener("pointercancel", () => {
    overviewPress = undefined;
    overviewPick.hidden = true;
  });

  elements.track.addEventListener("pointerleave", () => {
    elements.hover.hidden = true;
  });

  // Fewer labels on a narrow bar, such as a phone's, so they don't run
  // together
  new ResizeObserver(() => {
    const across = labelsAcross(elements.ticks.clientWidth);

    if (across === fit) return;

    fit = across;
    draw();
  }).observe(elements.ticks);

  return {
    show: (next) => {
      rows = next;
      drawOverview();
      draw();
    },
    playhead: (second) => {
      head = second;

      // Zoomed in, the view turns a page as the playhead nears its edge,
      // unless it's being dragged
      const nearEdge =
        second !== undefined &&
        (second < start + span * 0.05 || second > start + span * 0.9);

      if (
        nearEdge &&
        press === undefined &&
        overviewPress === undefined &&
        pinch === undefined &&
        span < daySeconds
      ) {
        start = clamp(second - span * 0.2);
        draw();

        return;
      }

      place(elements.playhead, head);
    },
    clip: (from, to) => {
      marked =
        from !== undefined && to !== undefined && to > from
          ? [from, to]
          : undefined;
      draw();
    },
    zoom: (seconds) => {
      zoomAround(seconds, head ?? start + span / 2, 0.5);
    },
    zoomBy: (factor) => {
      zoomAround(span / factor, head ?? start + span / 2, 0.5);
    },
  };
};
