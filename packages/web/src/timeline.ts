/**
 * The playback timeline under the player: one day's recordings as a bar,
 * a track per channel when several play, zoomed from the whole day down to
 * minutes. It follows the playhead, pans when dragged, and calls back with
 * the second of the day that's clicked, snapped to a recording just beside
 * it. It only draws; what plays is the page's to decide.
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
}

export interface Timeline {
  /** Draws a day's recordings, a track per row, in place of the last day's. */
  readonly show: (rows: ReadonlyArray<TimelineRow>) => void;
  /** Moves the playhead, or hides it; the view follows it when zoomed. */
  readonly playhead: (second: number | undefined) => void;
  /** Shows the stretch marked for a clip, or hides it. */
  readonly clip: (from: number | undefined, to: number | undefined) => void;
  /** How many seconds the bar shows, from a whole day down. */
  readonly zoom: (seconds: number) => void;
}

const daySeconds = 24 * 60 * 60;

/** How far a press moves before it's a drag rather than a click, in pixels. */
const dragAfter = 4;

/** How near a recording a press snaps to it, in pixels. */
const snapWithin = 12;

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

/** A timeline over `elements`; `onPick` hears the second of the day clicked. */
export const timelineFor = (
  elements: TimelineElements,
  onPick: (second: number) => void,
): Timeline => {
  let rows: ReadonlyArray<TimelineRow> = [];
  let span = daySeconds;
  let start = 0;
  let head: number | undefined;
  let marked: readonly [number, number] | undefined;
  let fit = 8;

  const clamp = (value: number) =>
    Math.min(Math.max(value, 0), daySeconds - span);

  const percent = (second: number) => `${((second - start) / span) * 100}%`;

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

    elements.clip.hidden = marked === undefined;

    if (marked !== undefined) {
      elements.clip.style.left = percent(marked[0]);
      elements.clip.style.width = `${((marked[1] - marked[0]) / span) * 100}%`;
    }
  };

  /** The second of the day under a pointer's x. */
  const secondAt = (x: number) => {
    const box = elements.track.getBoundingClientRect();

    if (box.width === 0) return start;

    const share = Math.min(Math.max((x - box.left) / box.width, 0), 1);

    return Math.min(Math.floor(start + share * span), daySeconds - 1);
  };

  /**
   * The second a press at `x` picks: off every recording, the nearest point
   * of the closest one within reach, as a short clip is a sliver across a day.
   */
  const pickAt = (x: number) => {
    const second = secondAt(x);
    const width = elements.track.getBoundingClientRect().width;
    const reach = width === 0 ? 0 : (snapWithin / width) * span;

    const nearest = rows
      .flatMap((row) => row.spans)
      .map((recording) => {
        if (second < recording.start) {
          return { at: recording.start, off: recording.start - second };
        }

        // Past a sliver, its start; past a long one, its last second
        if (second >= recording.end) {
          return {
            at:
              recording.end - recording.start <= reach
                ? recording.start
                : Math.max(recording.start, Math.ceil(recording.end) - 1),
            off: second - recording.end,
          };
        }

        return { at: second, off: 0 };
      })
      .reduce<{ at: number; off: number } | undefined>(
        (best, one) => (best === undefined || one.off < best.off ? one : best),
        undefined,
      );

    return nearest !== undefined && nearest.off <= reach ? nearest.at : second;
  };

  let press: { x: number; start: number; dragged: boolean } | undefined;

  elements.track.addEventListener("pointerdown", (event) => {
    press = { x: event.clientX, start, dragged: false };
    elements.track.setPointerCapture(event.pointerId);
  });

  elements.track.addEventListener("pointermove", (event) => {
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
    const picked = press !== undefined && !press.dragged;

    press = undefined;

    if (picked) onPick(pickAt(event.clientX));
  });

  elements.track.addEventListener("pointercancel", () => {
    press = undefined;
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
      draw();
    },
    playhead: (second) => {
      head = second;

      // Zoomed in, the view turns a page as the playhead nears its edge,
      // unless it's being dragged
      const nearEdge =
        second !== undefined &&
        (second < start + span * 0.05 || second > start + span * 0.9);

      if (nearEdge && press === undefined && span < daySeconds) {
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
      const centre = head ?? start + span / 2;

      span = Math.min(seconds, daySeconds);
      start = clamp(centre - span / 2);
      draw();
    },
  };
};
