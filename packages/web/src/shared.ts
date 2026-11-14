/**
 * What the pages share: finding and making elements, dates and times in the
 * browser's language, and recordings as table rows with Play and Download.
 */
import { RecordingReason, type Recording } from "@timmo001/kestrel-core";
import {
  type Swipe,
  type TableColumn,
  type TableRow,
  typingTargets,
} from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import { cameraLabel } from "./cameras.ts";
import {
  phCornersIn,
  phCornersOut,
  phDownloadSimple,
  phPlay,
} from "./icons.ts";
import { clipUrl, type Clip } from "./recording-player.ts";

/**
 * What a drag on a player already moves, so a touch starting there never
 * pulls the bar over the picture down: a zoomed picture, a camera being
 * steered, or a slider, popover or sheet.
 */
export const barDragIgnore =
  "[data-movable], [data-steering], .live-steer-dock, gw-range, gw-popover, gw-sheet";

/** The same, and the bar too, so a touch there never swipes between cameras. */
export const swipeIgnore = `${barDragIgnore}, .player-controls`;

/**
 * Wires a page's help popover to its button, both opening it when it's shut
 * and shutting it when it's open. Returns its toggle, for the `?` key, and
 * a way to open or close it, for a three finger swipe.
 */
export const helpToggle = (
  popover: HTMLElementTagNameMap["gw-popover"] | null,
  button: HTMLElementTagNameMap["gw-button"] | null,
) => {
  let open = false;

  popover?.addEventListener("close", () => {
    open = false;
  });

  const toggle = () => {
    if (popover === null || button === null) return;

    if (open) {
      popover.close();

      return;
    }

    open = true;
    popover.show(button);
  };

  button?.addEventListener("click", toggle);

  return {
    toggle,
    /**
     * Opens it on a three finger swipe up and shuts it on one down. Returns
     * whether the swipe was one of those, so the page's own swipes skip it.
     */
    swipe: (swipe: Swipe) => {
      if (swipe.fingers !== 3) return false;

      if (swipe.direction === "up" && !open) toggle();
      else if (swipe.direction === "down" && open) toggle();

      return swipe.direction === "up" || swipe.direction === "down";
    },
  };
};

/**
 * Puts an overlay that isn't inside a player in the page, and keeps it
 * inside whatever goes full screen while something does: Chromium shows one
 * outside the full screen element over it, but never lets it be pressed or
 * scrolled.
 */
export const followFullscreen = (overlay: HTMLElement) => {
  document.body.append(overlay);

  document.addEventListener("fullscreenchange", () => {
    (document.fullscreenElement ?? document.body).append(overlay);
  });
};

/**
 * A press anywhere in `area` hands the focus back to the `player`, so its
 * keys keep working rather than going to the button pressed. Fields, popovers
 * and sheets keep it, and the focus ring shows only when Tab brings it there.
 * Returns the focusing, for anything else that hands the focus back.
 */
export const focusOnPress = (
  area: HTMLElement | null,
  player: HTMLElement | null,
) => {
  const focus = () =>
    player?.focus({ preventScroll: true, focusVisible: false });

  area?.addEventListener("pointerup", (event) => {
    const kept = event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target.matches(`${typingTargets}, gw-popover, gw-sheet`),
      );

    if (!kept) requestAnimationFrame(focus);
  });

  return focus;
};

/**
 * Wires a player's full screen button: it takes `target` full screen, or
 * leaves, and its icon and name follow, with `onChange` after each change.
 */
export const fullscreenToggle = (
  button: HTMLElementTagNameMap["gw-button"] | null,
  target: HTMLElement | null,
  onChange?: () => void,
) => {
  const show = () => {
    const full = target !== null && document.fullscreenElement === target;

    controlIcon(button, full ? phCornersIn : phCornersOut, {
      label: full ? "Exit full screen (F)" : "Full screen (F)",
    });
  };

  button?.addEventListener("click", () => {
    if (document.fullscreenElement === null) {
      void target?.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    show();
    onChange?.();
  });

  show();
};

/**
 * A camera's settings panel that holds more than a popover's small form,
 * such as its moving setup's presets, home and tracking. It comes up from the
 * bottom where Groundwork's popups become bottom sheets, a phone either way
 * up, and otherwise in from the end edge, beside the cameras rather than
 * over the picture being set.
 */
export const settingsSheet = (className: string) => {
  const sheet = element("gw-sheet");

  sheet.classList.add(className);
  sheet.side = "auto";
  sheet.wideSide = "end";
  followFullscreen(sheet);

  return sheet;
};

/**
 * Draws one of a player's control buttons as an icon, named by its label,
 * which shows as its tooltip. The play button (`main`) leads, larger and on
 * a round filled button, as System Bridge's media controls do; the rest are
 * plain.
 */
export const controlIcon = (
  button: HTMLElementTagNameMap["gw-button"] | null,
  icon: string,
  options: {
    readonly label?: string | undefined;
    readonly main?: boolean;
  } = {},
) => {
  if (button === null) return;

  const main = options.main === true;

  button.setAttribute("icon", icon);
  button.setAttribute("labels", "hide");
  button.setAttribute("appearance", main ? "accent" : "plain");
  button.setAttribute("variant", main ? "brand" : "neutral");
  button.setAttribute("size", main ? "large" : "medium");

  if (options.label !== undefined) button.setAttribute("label", options.label);

  button.textContent = button.getAttribute("label") ?? "";
};

/**
 * `controlIcon` for one player's bar, where its `play` button leads and the
 * rest are plain.
 */
export const playerIcons =
  (play: HTMLElementTagNameMap["gw-button"] | null) =>
  (
    button: HTMLElementTagNameMap["gw-button"] | null,
    icon: string,
    label?: string,
  ) =>
    controlIcon(button, icon, { label, main: button === play });

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

    // Side by side, however narrow the column; gw-row keeps their touch hit
    // areas apart
    actions.setAttribute("nowrap", "");
    actions.append(play, save);

    return actions;
  },
});
