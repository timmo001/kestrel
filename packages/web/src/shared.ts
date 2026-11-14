/**
 * What the pages share: finding and making elements, dates and times in the
 * browser's language, and recordings as table rows with Play and Download.
 */
import { RecordingReason, type Recording } from "@timmo001/kestrel-core";
import {
  GwSegmented,
  GwVolume,
  on,
  onSwipe,
  type MenuItem,
  type TableColumn,
  type TableRow,
} from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import { cameraLabel } from "./cameras.ts";
import {
  phCaretDown,
  phCaretUp,
  phDotsThreeVertical,
  phDownloadSimple,
  phPlay,
} from "./icons.ts";
import { clipUrl, type Clip } from "./recording-player.ts";

/**
 * What a drag on a player already moves, so a touch starting there is never
 * a swipe: a zoomed picture, a camera being steered, or a control.
 */
export const swipeIgnore =
  "[data-movable], [data-steering], .player-controls, .live-steer-dock, gw-range, gw-popover, gw-sheet";

/** Fields that take text: a toggle's radios don't, so keys pass them by. */
export const typingTargets =
  "input:not([type=radio], [type=checkbox], [type=button], [type=range]), textarea, select, [contenteditable], gw-input, gw-select";

/** Controls that move between their own parts with the arrow keys. */
const ownsArrows =
  "gw-segmented, gw-table, gw-menu-button, gw-range, [role=menu]";

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

  return {
    toggle,
    /** Opens it, such as for a three finger swipe up. */
    show: () => {
      if (!open) toggle();
    },
    close: () => {
      if (open) toggle();
    },
  };
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
  document.body.append(sheet);

  return sheet;
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

  // Keys in an open sheet or popover are its own, Esc closing it
  if (path.some((target) => target.matches("gw-sheet, gw-popover"))) {
    return undefined;
  }

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

/** An element's width with its side margins. */
const outerWidth = (element: Element) => {
  const style = getComputedStyle(element);

  return (
    element.getBoundingClientRect().width +
    Number.parseFloat(style.marginLeft) +
    Number.parseFloat(style.marginRight)
  );
};

/**
 * What a group of controls needs to sit in one line, its showing controls
 * and the gaps between: with every one, and tight, with those marked
 * `data-overflow` folded into the More menu, which takes one button's room
 * in the group that has it, and a volume control as its button alone, its
 * slider sliding out or in a popover.
 */
const lineWidths = (group: Element | null) => {
  if (group === null) return { full: 0, tight: 0 };

  const shown = [...group.children].filter(
    (child) =>
      child.getBoundingClientRect().width > 0 &&
      !["absolute", "fixed"].includes(getComputedStyle(child).position),
  );

  const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;

  // A volume control, or a segmented one that folds options into its More,
  // measures as it is now, so it says what it needs; one nested in a row,
  // such as Live's pager, counts with the row
  const shrinker = (child: Element) =>
    [child, ...child.children].find(
      (each): each is GwVolume | GwSegmented =>
        each instanceof GwVolume ||
        (each instanceof GwSegmented && each.overflow),
    ) ?? null;

  const fullWidth = (child: Element) => {
    const inner = shrinker(child);

    if (inner === null) return outerWidth(child);

    return outerWidth(child) - outerWidth(inner) + inner.inlineWidth;
  };

  const tightWidth = (child: Element) => {
    const inner = shrinker(child);

    if (inner === null) return outerWidth(child);

    const least = Number.parseFloat(getComputedStyle(inner).minInlineSize);

    return outerWidth(child) - outerWidth(inner) + (least || 0);
  };

  const width = (
    children: ReadonlyArray<Element>,
    measure: (child: Element) => number,
  ) =>
    children.reduce((sum, child) => sum + measure(child), 0) +
    gap * Math.max(children.length - 1, 0);

  const folded = shown.filter((child) => child.hasAttribute("data-overflow"));
  const kept = shown.filter((child) => !child.hasAttribute("data-overflow"));

  const more =
    group.querySelector(":scope > .controls-more") === null ||
    folded.length === 0
      ? 0
      : Math.max(...folded.map(outerWidth)) + gap;

  return {
    full: width(shown, fullWidth),
    tight: width(kept, tightWidth) + more,
  };
};

/**
 * A player bar's More menu: the controls marked `data-overflow`, which are
 * seldom used, such as Capture and Download, folded into it while the bar
 * is tight or as on a phone. Each item mirrors its control, its label, icon
 * and whether it's on or can be pressed, and choosing it presses it.
 */
export const overflowMenu = (bar: HTMLElement) => {
  const more = [...bar.querySelectorAll("gw-menu-button")].find((each) =>
    each.classList.contains("controls-more"),
  );

  if (more === undefined) return;

  const controls = [...bar.querySelectorAll("gw-button")].filter((each) =>
    each.hasAttribute("data-overflow"),
  );

  more.setAttribute("icon", phDotsThreeVertical);

  /** A control as its item: a toggle's says whether it's on. */
  const itemFor = (
    control: HTMLElementTagNameMap["gw-button"],
    index: number,
  ): MenuItem => {
    const item: MenuItem = {
      value: String(index),
      label: control.getAttribute("label") ?? "",
      icon: control.getAttribute("icon") ?? "",
      disabled: control.disabled,
    };

    return control.hasAttribute("toggle")
      ? { ...item, checked: control.pressed }
      : item;
  };

  const show = () => {
    more.items = controls.flatMap((control, index) =>
      control.hidden ? [] : [itemFor(control, index)],
    );
  };

  on(more, "select", (event) => {
    const control = controls[Number(event.detail.value)];

    if (control === undefined || control.disabled) return;

    // A link, such as Download, is followed as its own would be
    const href = control.getAttribute("href");

    if (href === null) {
      control.click();

      return;
    }

    const link = element("a");

    link.href = href;
    link.download = "";
    link.click();
  });

  const watcher = new MutationObserver(show);

  for (const control of controls) {
    watcher.observe(control, {
      attributes: true,
      attributeFilter: ["label", "icon", "disabled", "pressed", "hidden"],
    });
  }

  show();
};

/**
 * Lays a player's control bar out in the fewest rows its controls fit,
 * never letting them wrap unevenly: in one row, the transport between the
 * start and end, in the middle where the sides leave it room; else in two,
 * the transport over the start and end; else as on a phone. Before taking
 * another row it tries the bar tight, a volume control down to its button
 * and the seldom used controls in More. It's measured laid out in a row, as
 * the controls differ by page and by what the cameras can do, and again as
 * the bar or its controls change size.
 */
export const compactWhenCrowded = (bar: HTMLElement) => {
  const fit = () => {
    bar.removeAttribute("data-compact");
    bar.removeAttribute("data-split");
    bar.removeAttribute("data-tight");

    // A hidden page has nothing to measure
    if (bar.clientWidth === 0) return;

    const [start, transport, end] = [
      "controls-start",
      "controls-transport",
      "controls-end",
    ].map((name) => lineWidths(bar.querySelector(`:scope > .${name}`)));

    const style = getComputedStyle(bar);
    const gap = Number.parseFloat(style.columnGap) || 0;

    const padding =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight);

    // A little to spare, as the measures round and the grid's don't
    const room = bar.clientWidth - padding - 16;

    const fits = (size: "full" | "tight") => {
      const [left = 0, middle = 0, right = 0] = [start, transport, end].map(
        (group) => group?.[size] ?? 0,
      );

      return {
        oneRow: left + middle + right + 2 * gap <= room,
        twoRows: left + right + gap <= room && middle <= room,
      };
    };

    const full = fits("full");
    const tight = fits("tight");

    // The fewest rows first, then every control where the rows are equal
    const [split, compact, tightened] = full.oneRow
      ? [false, false, false]
      : tight.oneRow
        ? [false, false, true]
        : full.twoRows
          ? [true, false, false]
          : tight.twoRows
            ? [true, false, true]
            : [false, true, false];

    bar.toggleAttribute("data-split", split);
    bar.toggleAttribute("data-compact", compact);
    bar.toggleAttribute("data-tight", tightened);
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
  "(orientation: landscape) and (max-height: 500px)",
);

/** How long the bar over the picture stays after the last touch, in milliseconds. */
const hideAfter = 3000;

/** A touch screen, which turning on its side takes the player full screen. */
const touchScreen = matchMedia("(pointer: coarse)");

/**
 * What a press does something on in a player: a control, a camera's own
 * controls on its tile, a popover, or a tile or video, which a press picks,
 * plays or pauses. A press on one never wakes the bar over the picture.
 */
const pressable = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=slider]",
  "[role=menuitem]",
  "[tabindex]:not([tabindex='-1'])",
  "gw-button",
  "gw-menu-button",
  "gw-segmented",
  "gw-select",
  "gw-range",
  "gw-input",
  "gw-popover",
  "gw-sheet",
  ".live-tile",
  ".player-tile",
  ".player-video",
].join(", ");

/**
 * On a phone on its side, or full screen, a player's control bar goes over
 * its picture and acts as a video player's: it fades out once it's been left
 * alone a moment while playing. It comes back, and goes, only from what
 * doesn't do anything else: a tap where there's nothing to press, a swipe up
 * (down hides it) where a drag doesn't already zoom or steer, a small handle
 * at the bottom that stays while it's hidden, a key, or a mouse moving. A
 * press on a control, a camera's own controls or a tile does its own thing,
 * and never wakes the bar or is swallowed by it. It stays while paused or
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
  const handle = element("gw-button");
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Where a press on nothing to press began, which a tap there toggles the bar from. */
  let press: { x: number; y: number } | undefined;
  /** Whether the press under way toggled the bar, so its click does nothing else. */
  let toggled = false;
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

  /**
   * Paused, as either page's Play button says, with its rows open, or with
   * one of its menus or popovers open: hidden, the bar would stop taking
   * presses, and so would the open one's surface and the clear layer that
   * keeps a press outside from reaching the cameras.
   */
  const stays = () =>
    bar.hasAttribute("data-expanded") ||
    [...bar.querySelectorAll("*")].some((each) =>
      each.shadowRoot?.querySelector(".gw-scrim:popover-open"),
    ) ||
    (
      bar.querySelector(".control-play, .live-play")?.getAttribute("label") ??
      ""
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

  /** Hides the bar at once, unless it stays. */
  const hide = () => {
    clearTimeout(timer);
    timer = undefined;

    if (isOver() && !stays()) bar.toggleAttribute("data-hidden", true);
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

  // The handle that brings the bar back, at the bottom while it's hidden
  handle.className = "controls-handle";
  handle.setAttribute("icon", phCaretUp);
  handle.setAttribute("label", "Show the controls");
  handle.setAttribute("labels", "hide");
  handle.setAttribute("appearance", "plain");
  handle.setAttribute("variant", "neutral");
  handle.setAttribute("size", "medium");
  handle.addEventListener("click", wake);

  // A press on nothing to press can toggle the bar, if it's a tap
  stage?.addEventListener(
    "pointerdown",
    (event) => {
      toggled = false;

      const pressed = event
        .composedPath()
        .some(
          (target) => target instanceof Element && target.matches(pressable),
        );

      press =
        !isOver() || pressed
          ? undefined
          : { x: event.clientX, y: event.clientY };
    },
    true,
  );

  stage?.addEventListener(
    "pointerup",
    (event) => {
      if (press === undefined) return;

      const tap =
        Math.hypot(event.clientX - press.x, event.clientY - press.y) < 10;

      press = undefined;

      if (!tap) return;

      toggled = true;

      if (bar.hasAttribute("data-hidden")) wake();
      else hide();
    },
    true,
  );

  // A swipe of one finger up shows it, and down hides it
  if (stage !== null) {
    onSwipe(
      stage,
      (swipe) => {
        if (!isOver() || swipe.fingers !== 1) return;

        if (swipe.direction === "up") wake();
        else if (swipe.direction === "down") hide();
      },
      { ignore: swipeIgnore },
    );
  }

  // One the browser takes over, such as to scroll, toggles nothing
  stage?.addEventListener("pointercancel", () => {
    press = undefined;
  });

  // A press that toggled the bar does nothing else
  for (const type of ["click", "dblclick"]) {
    stage?.addEventListener(
      type,
      (event) => {
        if (!toggled) return;

        event.stopPropagation();

        if (type === "click") toggled = false;
      },
      true,
    );
  }

  // Using the bar keeps it up
  bar.addEventListener("pointerdown", wake);

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
  stage?.append(handle);
  place();
};

/**
 * Keeps each element's `--fill-top` at its distance from the top of the
 * page, which the styles take from the window's height so a player fills it
 * under whatever's above: the app bar, and banners and alerts that come and
 * go. It's measured again as the page's height changes, which they change,
 * and after full screen, where the element sits at the top.
 */
export const fillWindow = (elements: ReadonlyArray<HTMLElement | null>) => {
  const measure = () => {
    for (const each of elements) {
      // Hidden, or full screen, it has nowhere of its own to measure
      if (
        each === null ||
        each.getClientRects().length === 0 ||
        document.fullscreenElement === each
      ) {
        continue;
      }

      each.style.setProperty(
        "--fill-top",
        `${each.getBoundingClientRect().top + scrollY}px`,
      );
    }
  };

  new ResizeObserver(measure).observe(document.body);
  document.addEventListener("fullscreenchange", measure);
  measure();
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
