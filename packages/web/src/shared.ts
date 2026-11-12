/**
 * What the pages share: finding and making elements, dates and times in the
 * browser's language, and recordings as table rows with Play and Download.
 */
import {
  RecordingReason,
  type Recording,
} from "@timmo001/kestrel-rsnet/domain";
import type { TableColumn, TableRow } from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import { phDownloadSimple, phPlay } from "./icons.ts";
import { clipUrl, type Clip } from "./player.ts";

/** Fields that take text: a toggle's radios don't, so keys pass them by. */
export const typingTargets =
  "input:not([type=radio], [type=checkbox], [type=button], [type=range]), textarea, select, [contenteditable], gw-input, gw-select";

/** Controls that move between their own parts with the arrow keys. */
const ownsArrows = "gw-segmented, gw-table, gw-menu-button, [role=menu]";

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

/**
 * A recording as a table row: `bytes` sorts the size column, `size` shows
 * it, and `from` and `to` keep the full times for playing it.
 */
export const recordingRow = (recording: Recording): TableRow => ({
  key: `${recording.channel}-${recording.begin}`,
  channel: recording.channel,
  begin: clock(recording.begin),
  end: clock(recording.end),
  from: recording.begin,
  to: recording.end,
  length: duration(recording.begin, recording.end),
  reasons: recording.reasons.join(", "),
  bytes: recording.bytes,
  size: size(recording.bytes),
});

export const rowClip = (row: TableRow): Clip => ({
  channel: Number(row.channel),
  begin: String(row.from),
  end: String(row.to),
});

/** A column of each row's Play and Download buttons; Play calls `onPlay`. */
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
    }

    play.setAttribute("icon", phPlay);
    play.addEventListener("click", () => onPlay(rowClip(row)));
    save.setAttribute("icon", phDownloadSimple);
    save.setAttribute("variant", "neutral");
    save.setAttribute("href", clipUrl(rowClip(row), true));
    // Side by side, however narrow the column
    actions.setAttribute("nowrap", "");
    actions.setAttribute("gap", "s");
    actions.append(play, save);

    return actions;
  },
});
