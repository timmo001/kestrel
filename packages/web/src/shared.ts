/**
 * What the pages share: finding and making elements, dates and times in the
 * browser's language, and recordings as table rows with Play and Download.
 */
import { RecordingReason, type Recording } from "@timmo001/kestrel-core";
import type { TableColumn, TableRow } from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import { cameraLabel } from "./cameras.ts";
import { phCaretDown, phCaretUp, phDownloadSimple, phPlay } from "./icons.ts";
import { clipUrl, type Clip } from "./recording-player.ts";

/** Fields that take text: a toggle's radios don't, so keys pass them by. */
export const typingTargets =
  "input:not([type=radio], [type=checkbox], [type=button], [type=range]), textarea, select, [contenteditable], gw-input, gw-select";

/** Controls that move between their own parts with the arrow keys. */
const ownsArrows =
  "gw-segmented, gw-table, gw-menu-button, gw-range, [role=menu]";

/**
 * Wires a page's keys popover to its button, both opening it when it's shut
 * and shutting it when it's open. Returns the toggle, for the `?` key.
 */
export const helpToggle = (
  popover: HTMLElementTagNameMap["gw-popover"] | null,
  button: HTMLElementTagNameMap["gw-button"] | null,
) => {
  let open = false;
  /** Whether it was open as the button was pressed, before that press shut it. */
  let openOnPress = false;

  popover?.addEventListener("close", () => {
    open = false;
  });

  // Ahead of the popover's own listener, which shuts it on a press outside
  window.addEventListener(
    "pointerdown",
    (event) => {
      openOnPress =
        open && button !== null && event.composedPath().includes(button);
    },
    true,
  );

  const toggle = () => {
    if (popover === null || button === null) return;

    if (open) {
      popover.close();

      return;
    }

    open = true;
    popover.show(button);
  };

  button?.addEventListener("click", () => {
    if (openOnPress) {
      openOnPress = false;

      return;
    }

    toggle();
  });

  return toggle;
};

/**
 * Keeps a popover whose changes apply as they're made from holding them as
 * unsaved, so it closes at once rather than asking to discard them. Its own
 * listener marks them first, as it was added when the popover was made.
 */
export const appliesAtOnce = (popover: HTMLElementTagNameMap["gw-popover"]) => {
  for (const type of ["input", "change"]) {
    popover.addEventListener(type, () => {
      popover.dirty = false;
    });
  }
};

/**
 * The key a page's keyboard controls act on, such as `k`, `F` lowered to
 * `f`, or `Shift+ArrowLeft`; or undefined where it belongs to what has the
 * focus: a field being typed in, a toggle's arrows, or Space on a button.
 */
export const controlKey = (event: KeyboardEvent): string | undefined => {
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.defaultPrevented
  ) {
    return undefined;
  }

  const path = event
    .composedPath()
    .filter((target) => target instanceof Element);

  if (path.some((target) => target.matches(typingTargets))) return undefined;

  if (
    event.key.startsWith("Arrow") &&
    path.some((target) => target.matches(ownsArrows))
  ) {
    return undefined;
  }

  // Space on a focused button presses that button, as it should
  if (
    event.key === " " &&
    path.some((target) => target.matches("button, a, gw-button, [role=radio]"))
  ) {
    return undefined;
  }

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  return event.shiftKey && key.startsWith("Arrow") ? `Shift+${key}` : key;
};

/** An element's width with its side margins. */
const outerWidth = (element: Element) => {
  const style = getComputedStyle(element);

  return (
    element.getBoundingClientRect().width +
    Number.parseFloat(style.marginLeft) +
    Number.parseFloat(style.marginRight)
  );
};

/** What a group of controls needs to sit in one line: its showing controls and the gaps between. */
const lineWidth = (group: Element) => {
  const shown = [...group.children].filter(
    (child) =>
      child.getBoundingClientRect().width > 0 &&
      !["absolute", "fixed"].includes(getComputedStyle(child).position),
  );

  const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;

  return (
    shown.reduce((sum, child) => sum + outerWidth(child), 0) +
    gap * Math.max(shown.length - 1, 0)
  );
};

/**
 * Lays a player's control bar out in the most room it has, never letting
 * its controls wrap unevenly: in one row, with the transport in the middle
 * and the start and end either side; or in two, the transport over the start
 * and end; or else as on a phone. It's measured laid out in a row, as the
 * controls differ by page and by what the cameras can do, and again as the
 * bar or its controls change size.
 */
export const compactWhenCrowded = (bar: HTMLElement) => {
  const fit = () => {
    bar.removeAttribute("data-compact");
    bar.removeAttribute("data-split");

    // A hidden page has nothing to measure
    if (bar.clientWidth === 0) return;

    const [start, transport, end] = [
      "controls-start",
      "controls-transport",
      "controls-end",
    ].map((name) => {
      const group = bar.querySelector(`:scope > .${name}`);

      return group === null ? 0 : lineWidth(group);
    });

    const style = getComputedStyle(bar);
    const gap = Number.parseFloat(style.columnGap) || 0;

    const padding =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight);

    const sides = Math.max(start ?? 0, end ?? 0);
    const room = bar.clientWidth - padding;
    const oneRow = 2 * sides + (transport ?? 0) + 2 * gap <= room;

    const twoRows =
      (start ?? 0) + (end ?? 0) + gap <= room && (transport ?? 0) <= room;

    bar.toggleAttribute("data-split", !oneRow && twoRows);
    bar.toggleAttribute("data-compact", !oneRow && !twoRows);
  };

  const observer = new ResizeObserver(fit);

  // Its border box: laid out as on a phone, its padding keeps the content
  // a phone's width, so the content box doesn't change as the bar widens
  observer.observe(bar, { box: "border-box" });

  // A control shown or hidden, such as Recordings' View menu, or a wider
  // label, changes what the row needs
  for (const control of bar.querySelectorAll(":scope > * > *")) {
    observer.observe(control);
  }
};

/** A phone on its side, where a player's control bar goes over its picture. */
const overPicture = matchMedia(
  "(orientation: landscape) and (max-height: 32rem)",
);

/** How long the bar over the picture stays after the last touch, in milliseconds. */
const hideAfter = 3000;

/** A touch screen, which turning on its side takes the player full screen. */
const touchScreen = matchMedia("(pointer: coarse)");

/**
 * On a phone on its side, or full screen, a player's control bar goes over
 * its picture and acts as a video player's: it fades out once it's been left
 * alone a moment while playing, and a tap on the picture, or moving the
 * mouse, brings it back, the tap doing nothing else. It stays while paused or
 * while its rows past the first are open, from a tab on its top edge. Turning
 * a phone on its side takes the player full screen where the browser lets
 * it, and turning it back leaves.
 */
export const overlayControls = (bar: HTMLElement) => {
  const stage = bar.parentElement;
  /** What the page puts full screen: the player, with Recordings' timeline. */
  const around = bar.closest(".playback-view, .live-stage");
  const player = around instanceof HTMLElement ? around : null;
  const tab = element("gw-button");
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the press under way only woke the bar, so does nothing else. */
  let waking = false;
  /** Whether turning the phone on its side put the player full screen. */
  let turned = false;

  const isOver = () =>
    overPicture.matches || (document.fullscreenElement?.contains(bar) ?? false);

  tab.className = "controls-expand";
  tab.setAttribute("labels", "hide");
  tab.setAttribute("appearance", "plain");
  tab.setAttribute("variant", "neutral");
  tab.setAttribute("size", "small");

  const showTab = () => {
    const open = bar.hasAttribute("data-expanded");

    tab.setAttribute("icon", open ? phCaretDown : phCaretUp);
    tab.setAttribute("label", open ? "Fewer controls" : "More controls");
    tab.setAttribute("aria-expanded", String(open));
  };

  /** Paused, as Recordings' Play button says, or with its rows open. */
  const stays = () =>
    bar.hasAttribute("data-expanded") ||
    (
      bar.querySelector(".control-play")?.getAttribute("label") ?? ""
    ).startsWith("Play");

  const sleep = () => {
    timer = undefined;

    if (!isOver()) return;

    if (stays()) {
      timer = setTimeout(sleep, hideAfter);

      return;
    }

    bar.toggleAttribute("data-hidden", true);
  };

  const wake = () => {
    bar.removeAttribute("data-hidden");
    clearTimeout(timer);
    timer = isOver() ? setTimeout(sleep, hideAfter) : undefined;
  };

  /** Over the picture or under it, as the window and full screen have it. */
  const place = () => {
    stage?.toggleAttribute("data-overlay", isOver());
    wake();
  };

  tab.addEventListener("click", () => {
    bar.toggleAttribute("data-expanded");
    showTab();
    wake();
  });

  // Ahead of the picture's own presses, which play, pause or pick
  stage?.addEventListener(
    "pointerdown",
    (event) => {
      waking = isOver() && bar.hasAttribute("data-hidden");

      if (waking) event.stopPropagation();

      wake();
    },
    true,
  );

  for (const type of ["pointerup", "click", "dblclick"]) {
    stage?.addEventListener(
      type,
      (event) => {
        if (!waking) return;

        event.stopPropagation();

        if (type !== "pointerup") waking = false;
      },
      true,
    );
  }

  // A mouse moving over the picture brings the bar back, as a video player's;
  // a finger's only moves once it's down, which has already
  stage?.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") wake();
  });

  document.addEventListener("keydown", wake);
  overPicture.addEventListener("change", place);

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === null) turned = false;

    place();
  });

  // Browsers mostly let a page go full screen only from a tap, so turning
  // the phone may not be enough; then it stays as it is
  if ("orientation" in screen) {
    screen.orientation.addEventListener("change", () => {
      // Only the page showing, on a phone, where full screen is allowed
      if (
        player === null ||
        !touchScreen.matches ||
        !document.fullscreenEnabled ||
        bar.getClientRects().length === 0
      ) {
        return;
      }

      const sideways = screen.orientation.type.startsWith("landscape");

      if (sideways && document.fullscreenElement === null) {
        void player.requestFullscreen().then(
          () => {
            turned = true;
          },
          () => undefined,
        );
      } else if (!sideways && turned) {
        turned = false;
        void document.exitFullscreen().catch(() => undefined);
      }
    });
  }

  showTab();
  bar.append(tab);
  place();
};

/** The first `tag` element with `className`, or null. */
export const find = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
) =>
  [...document.querySelectorAll(tag)].find((found) =>
    found.classList.contains(className),
  ) ?? null;

export const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
) => {
  const created = document.createElement(tag);

  if (text !== undefined) created.textContent = text;

  return created;
};

// Dates and times in the browser's preferred language. Chrome formats with
// its interface language by default, which can differ, such as US dates for
// someone who prefers British English.
const locales = navigator.languages;

export const dayFormat = new Intl.DateTimeFormat(locales, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

export const dateTimeFormat = new Intl.DateTimeFormat(locales, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export const timeFormat = new Intl.DateTimeFormat(locales, {
  timeStyle: "medium",
});

/**
 * A recorder time or day, such as `2026-11-12` or `2026-11-12T08:30:00`, as
 * a local `Date`: the recorder keeps its clock in local time, with no zone.
 */
export const localDate = (time: string) =>
  new Date(time.length === 10 ? `${time}T00:00:00` : time);

/** A local `Date`'s day as `YYYY-MM-DD`, the form the server takes. */
export const isoDay = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

/** A recorder time's time of day, `HH:MM:SS`. */
export const clock = (time: string) => time.slice(11, 19);

/** A recorder time's second of its day. */
export const seconds = (time: string) => {
  const [hours = 0, minutes = 0, rest = 0] = clock(time).split(":").map(Number);

  return hours * 3600 + minutes * 60 + rest;
};

const duration = (begin: string, end: string) => {
  const total = Math.max(seconds(end) - seconds(begin), 0);
  const minutes = Math.floor(total / 60);

  return minutes > 0 ? `${minutes} min ${total % 60} s` : `${total} s`;
};

const size = (bytes: number | null) =>
  bytes === null
    ? "Unknown"
    : bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
      : `${Math.round(bytes / 1024 ** 2)} MiB`;

const isReason = Schema.is(RecordingReason);

/** Each reason's colour, on chips and on the timeline. */
export const reasonTones: Record<RecordingReason, string> = {
  normal: "neutral",
  manual: "info",
  alarm: "warning",
  motion: "warning",
  "alarm input": "warning",
  PIR: "important",
  timelapse: "accent",
};

/** Chips for a row's reasons, which the row keeps as one comma-separated value. */
export const reasonChips = (row: TableRow) => {
  const chips = element("gw-row");

  for (const reason of String(row.reasons ?? "").split(", ")) {
    if (!isReason(reason)) continue;

    const chip = element("gw-chip", reason);

    chip.setAttribute("tone", reasonTones[reason]);
    chips.append(chip);
  }

  return chips;
};

/** Where a recording is: here, on its source, or only on a source that can't hand it over. */
const whereOf = (recording: Recording) => {
  if (recording.playable === false) return "On source only";

  return recording.remote === true ? "On source" : "Here";
};

/**
 * A recording as a table row: `bytes` sorts the size column, `size` shows
 * it, and `from` and `to` keep the full times for playing it.
 */
export const recordingRow = (recording: Recording): TableRow => ({
  key: `${recording.camera}-${recording.begin}`,
  camera: recording.camera,
  cameraLabel: cameraLabel(recording.camera),
  begin: clock(recording.begin),
  end: clock(recording.end),
  from: recording.begin,
  to: recording.end,
  length: duration(recording.begin, recording.end),
  reasons: recording.reasons.join(", "),
  bytes: recording.bytes,
  size: size(recording.bytes),
  where: whereOf(recording),
  playable: recording.playable !== false,
});

export const rowClip = (row: TableRow): Clip => ({
  camera: String(row.camera),
  begin: String(row.from),
  end: String(row.to),
});

/**
 * A column of each row's Play and Download buttons; Play calls `onPlay`.
 * They're off for a recording that can't be played.
 */
export const actionsColumn = (onPlay: (clip: Clip) => void): TableColumn => ({
  id: "actions",
  header: "",
  sortable: false,
  cell: (row) => {
    const actions = element("gw-row");
    const play = element("gw-button", "Play");
    const save = element("gw-button", "Download");

    for (const button of [play, save]) {
      button.setAttribute("size", "small");
      button.setAttribute("appearance", "plain");
      button.setAttribute("labels", "hide");
      button.disabled = row.playable === false;
    }

    play.setAttribute("icon", phPlay);
    play.addEventListener("click", () => onPlay(rowClip(row)));
    save.setAttribute("icon", phDownloadSimple);
    save.setAttribute("variant", "neutral");

    if (row.playable !== false) {
      save.setAttribute("href", clipUrl(rowClip(row), true));
    }

    // Side by side, however narrow the column
    actions.setAttribute("nowrap", "");
    actions.setAttribute("gap", "s");
    actions.append(play, save);

    return actions;
  },
});
