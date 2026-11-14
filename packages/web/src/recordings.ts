/**
 * The Recordings page, laid out as the recorder's own client lays out
 * playback: the video, a row of controls under it, then the day's timeline,
 * filling the window, with the clip and the day's recordings below. Play,
 * Stop, a frame at a time, the recordings either side, speed, Cut for a
 * clip, Capture for a still and Download, then the recorder's clock, zoom
 * and full screen. The cameras and day come from the address; where it was,
 * its speed and the timeline's zoom are kept in this browser for next time,
 * and the picture's zoom only while the page is open.
 */
import {
  cameraParts,
  LocalDate,
  LocalTime,
  type Camera,
  type CameraId,
  type Recording,
} from "@timmo001/kestrel-core";
import { on, type TableRow } from "@timmo001/groundwork-ui";
import { isText, keep, keptAt } from "@timmo001/groundwork-ui/kept.ts";
import { Option, Schema } from "effect";
import { SavedCamera } from "./addresses.ts";
import { call } from "./api.ts";
import { cameraLabel, fileName } from "./cameras.ts";
import {
  phBellRinging,
  phCamera,
  phCaretLeft,
  phCaretLineRight,
  phCaretRight,
  phCornersIn,
  phCornersOut,
  phDotsThreeVertical,
  phDownloadSimple,
  phFunnelSimple,
  phMagnifyingGlassMinus,
  phMagnifyingGlassPlus,
  phQuestion,
  phPause,
  phPlay,
  phScissors,
  phSkipBack,
  phSkipForward,
  phSquaresFour,
  phStop,
} from "./icons.ts";
import { mostCameras, playerGroup, type GroupTile } from "./player-group.ts";
import {
  eventSpans,
  nextMoment,
  nextSpan,
  previousMoment,
  previousSpan,
  spanAt,
  type Span,
  type Track,
} from "./moments.ts";
import {
  clipUrl,
  fullView,
  toSeconds,
  type Clip,
  type View,
} from "./recording-player.ts";
import type { RecordingsSearch } from "./router.ts";
import {
  actionsColumn,
  clock,
  controlKey,
  dayFormat,
  element,
  find,
  helpToggle,
  isoDay,
  localDate,
  reasonChips,
  reasonTones,
  recordingRow,
  seconds,
  timeFormat,
  typingTargets,
} from "./shared.ts";
import { timelineFor, type TimelineSpan } from "./timeline.ts";
import { tilingModes, type TilingMode } from "./tiling.ts";
import { pictureZoom, type PictureView, type ZoomTile } from "./zoom.ts";

// Phosphor's regular icons, as Upkeep uses
const icons = {
  play: phPlay,
  pause: phPause,
  stop: phStop,
  frame: phCaretLineRight,
  previous: phSkipBack,
  next: phSkipForward,
  nextEvent: phBellRinging,
  eventsOnly: phFunnelSimple,
  cut: phScissors,
  capture: phCamera,
  download: phDownloadSimple,
  zoomIn: phMagnifyingGlassPlus,
  zoomOut: phMagnifyingGlassMinus,
  fullscreen: phCornersOut,
  exitFullscreen: phCornersIn,
};

/** The speeds on the toggle; any other is typed in from its Custom option. */
const speeds = ["0.5", "1", "2", "4", "8", "16", "24", "32"];

/** The toggle's last option, which opens a field for any other speed. */
const customSpeed = "custom";

const slowest = 0.1;
const fastest = 32;

/** The fastest a browser plays a video: Chrome stops at 16. */
const browserFastest = 16;

/** How many times real time the recorder's full stream keeps up with across channels, with some to spare. */
const fullStreamBudget = 14;

/**
 * What a speed plays from. Up to the browser's fastest, the full stream at
 * that rate. Past it, the recorder's own fast forward: every key frame of
 * the full stream, one a second, which comes about 58 times faster than
 * real time where the whole stream comes at 17, sped up by the server to a
 * rate the browser can play. The full stream is shared, though: with
 * several cameras past about 14 times in all, every camera plays the
 * small sub stream, which comes 100 to 200 times faster than real time.
 */
const viewFor = (speed: number, count: number): View => {
  const speedUp = Math.ceil(speed / browserFastest);

  if (count > 1 && speed * count > fullStreamBudget) {
    return { stream: "sub", speedUp };
  }

  return speedUp > 1 ? { stream: "main", speedUp, every: 1 } : fullView;
};

const isSpeed = (speed: number) =>
  Number.isFinite(speed) && speed >= slowest && speed <= fastest;

const speedLabel = (speed: string) => `${speed === "0.5" ? "½" : speed}×`;

/** The timeline's zoom levels, in seconds shown across it. */
const timelineZooms = [
  { value: "86400", label: "Day" },
  { value: "14400", label: "4 h" },
  { value: "3600", label: "1 h" },
  { value: "600", label: "10 min" },
];

/** The main stream's frame rate, for a step of one frame. */
const frameSeconds = 1 / 15;

const daySeconds = 24 * 60 * 60;

/** How soon a second press makes a double click, in milliseconds. */
const doublePress = 400;

/** How often where it's playing is kept, in milliseconds. */
const keepEvery = 2000;

/** How often today's recordings are read again, in milliseconds. */
const refreshEvery = 30_000;

/** Where this page's settings are kept, as Upkeep keeps its pages'. */
const storageKey = "kestrel.recordings";

/**
 * Where it was playing: a recording and the seconds into it. One kept
 * before camera ids names the recorder's channel instead.
 */
const Position = Schema.Struct({
  camera: Schema.optional(SavedCamera),
  channel: Schema.optional(SavedCamera),
  begin: LocalTime,
  end: LocalTime,
  offset: Schema.Finite,
});

const decodePosition = Schema.decodeUnknownOption(Position);
const decodeCamera = Schema.decodeUnknownOption(SavedCamera);
const decodeCameras = Schema.decodeUnknownOption(Schema.Array(SavedCamera));
const isDate = Schema.is(LocalDate);

/** What's kept, each part checked, since anyone can edit it. */
const kept = () => {
  const values = keptAt(storageKey);

  // Kept before camera ids, the cameras are the recorder's channels by number
  const camera = Option.getOrUndefined(
    decodeCamera(values?.["camera"] ?? values?.["channel"]),
  );

  const ticked = Option.getOrUndefined(
    decodeCameras(values?.["cameras"] ?? values?.["channels"]),
  );

  const position = Option.getOrUndefined(decodePosition(values?.["position"]));
  const positionCamera = position?.camera ?? position?.channel;
  const date = values?.["date"];
  const speed = values?.["speed"];
  const tiling = values?.["tiling"];
  const timelineZoom = values?.["timelineZoom"];

  return {
    camera,
    cameras: ticked !== undefined && ticked.length > 0 ? ticked : undefined,
    date: isDate(date) ? date : undefined,
    speed: isText(speed) && isSpeed(Number(speed)) ? speed : "1",
    smart: tiling !== "fixed",
    eventsOnly: values?.["eventsOnly"] === true,
    timelineZoom:
      isText(timelineZoom) &&
      timelineZooms.some((zoom) => zoom.value === timelineZoom)
        ? timelineZoom
        : "86400",
    position:
      position === undefined || positionCamera === undefined
        ? undefined
        : {
            camera: positionCamera,
            begin: position.begin,
            end: position.end,
            offset: position.offset,
          },
  };
};

/** Starts a file download from a link. */
const save = (href: string, name?: string) => {
  const link = element("a");

  link.href = href;
  link.download = name ?? "";
  link.click();
};

export interface RecordingsOptions {
  /** Asks to show cameras and a day: the page follows once the address does. */
  readonly onPick: (search: RecordingsSearch) => void;
}

export interface RecordingsPage {
  /** The cameras with recordings, and the last day, which is the default one. */
  readonly start: (today: string, cameras: ReadonlyArray<Camera>) => void;
  /** Shows what the address asks for: cameras, a day and a time to play. */
  readonly open: (search: RecordingsSearch) => void;
  /** Pauses, for when the page is left. */
  readonly pause: () => void;
  /** Gives the player the focus, so the keyboard controls work at once. */
  readonly focus: () => void;
}

/** The Recordings page, wired to its elements. */
export const recordingsPage = (options: RecordingsOptions): RecordingsPage => {
  const dayPicker = find("gw-date-picker", "day");
  const previousDay = find("gw-button", "day-previous");
  const nextDay = find("gw-button", "day-next");
  const cameraSelect = find("gw-select", "camera");
  const recordedDays = find("gw-row", "recorded-days");
  const table = find("gw-table", "recordings");
  const grid = find("div", "player-grid");
  const view = find("div", "playback-view");
  const stage = find("div", "player-stage");
  const screen = find("div", "player-screen");
  const caption = find("span", "player-caption");
  const problem = find("gw-alert", "player-problem");
  const playerClock = find("span", "player-clock");
  const playButton = find("gw-button", "control-play");
  const stopButton = find("gw-button", "control-stop");
  const frameButton = find("gw-button", "control-frame");
  const previousButton = find("gw-button", "control-previous");
  const nextButton = find("gw-button", "control-next");
  const nextEventButton = find("gw-button", "control-next-event");
  const eventsButton = find("gw-button", "control-events");
  const speedToggle = find("gw-segmented", "control-speed");
  const speedCustom = find("gw-popover", "speed-custom");
  const speedOther = find("gw-input", "control-speed-other");
  const cutButton = find("gw-button", "control-cut");
  const captureButton = find("gw-button", "control-capture");
  const downloadButton = find("gw-button", "control-download");
  const zoomOutButton = find("gw-button", "control-zoom-out");
  const zoomFitButton = find("gw-button", "control-zoom-fit");
  const zoomInButton = find("gw-button", "control-zoom-in");
  const fitToggle = find("gw-segmented", "control-fit");
  const fullscreenButton = find("gw-button", "control-fullscreen");
  const helpButton = find("gw-button", "control-help");
  const moreMenu = find("gw-menu-button", "control-more");
  const viewMenu = find("gw-menu-button", "control-view");
  const clipFrom = find("gw-input", "clip-from");
  const clipTo = find("gw-input", "clip-to");
  const clipDownload = find("gw-button", "clip-download");
  const timelineZoom = find("gw-segmented", "timeline-zoom");

  const saved = kept();
  let lastDay = "";
  /** The cameras with recordings, in order. */
  let cameras: ReadonlyArray<Camera> = [];
  let day = "";
  /** The picked camera: first and largest, and what Cut and Download act on. */
  let camera: CameraId = "";
  /** Every camera playing, the picked one among them. */
  let ticked: ReadonlyArray<CameraId> = [];
  /** Whether the picked one shows alone, of several ticked. */
  let alone = false;
  /** Smart tiling, sized to the space as on Live, or fixed layouts; kept in this browser. */
  let smart = saved.smart;
  let speed = saved.speed;

  /** What the address asked for before the cameras were known. */
  let waiting: RecordingsSearch | undefined;

  /** The last `at` played, so the same address doesn't play it again. */
  let playedAt: string | undefined;

  /** Whether the kept position has been offered, which is once. */
  let resumed = false;

  /** Each playing camera's recordings on the picked day, earliest first. */
  let tracks: ReadonlyArray<Track> = [];

  /** The stretches around their events, which Events only plays and E and W skip between. */
  let spans: ReadonlyArray<Span> = [];

  /** Whether only the events play, the rest skipped; kept in this browser. */
  let eventsOnly = saved.eventsOnly;

  /** Where a skip to an event is headed, until it gets there, so the time before it loads isn't skipped from again. */
  let skipping: { readonly to: number; readonly since: number } | undefined;

  /** The stream and speed-up playing, which the caption names. */
  let shownView = fullView;

  /** What the toggle's Custom option says now, so it's only remade when that changes. */
  let shownCustomLabel: string | undefined;

  /** All of them together, earliest first, for the table and the timeline's clicks. */
  let recordings: ReadonlyArray<Recording> = [];

  /** Those and the ones that can't be played, as the table lists them. */
  let listed: ReadonlyArray<Recording> = [];

  /** Shows `text` over the player until something else plays. */
  const showNote = (text: string) => {
    if (problem === null) return;

    problem.textContent = text;
    problem.hidden = false;
  };

  const hideNote = () => {
    if (problem !== null) problem.hidden = true;
  };

  /** Set below: loads a recording from `from` seconds in, playing unless told not to. */
  let playClip: (clip: Clip, from?: number, autoplay?: boolean) => void = () =>
    undefined;

  /** Set below: what the controls, the clock and the timeline show. */
  let showState: () => void = () => undefined;

  let showTime: () => void = () => undefined;

  /** Set below: makes another playing camera the picked one. */
  let pickCamera: (picked: CameraId) => void = () => undefined;

  // A player per camera on one clock; it runs on into the next recording,
  // as the recorder's client does. Each tile shows its own problems
  const player =
    grid === null
      ? undefined
      : playerGroup(grid, {
          onTime: () => showTime(),
          onState: () => showState(),
          onPick: (picked) => pickCamera(picked),
        });

  // Where it's playing is kept every few seconds, and as the page goes, so
  // the page can pick up there next time
  let keptAtTime = 0;

  const keepPosition = (now = false) => {
    const clip = player?.clip();
    const offset = player?.offset();

    if (!now && Date.now() - keptAtTime < keepEvery) return;

    keptAtTime = Date.now();
    keep(storageKey, {
      position:
        clip === undefined || offset === undefined
          ? null
          : {
              camera: clip.camera,
              begin: clip.begin,
              end: clip.end,
              offset: Math.floor(offset),
            },
    });
  };

  window.addEventListener("pagehide", () => keepPosition(true));

  // The timeline: the picked day's recordings, the playhead, and the clip

  /** Where a recorder time falls on the picked day, in seconds, held to the day. */
  const secondOfDay = (time: string) => {
    const date = time.slice(0, 10);

    return date < day ? 0 : date > day ? daySeconds : seconds(time);
  };

  /** Whether `clip` is on the day and cameras the timeline shows. */
  const onTimeline = (clip: Clip) =>
    ticked.includes(clip.camera) && clip.begin.slice(0, 10) === day;

  /** A recording at a second of the picked day on any playing camera, or the next one after it. */
  const recordingAt = (second: number) =>
    recordings.find((recording) => secondOfDay(recording.end) > second);

  const timelineTrack = find("div", "timeline-track");
  const timelineSpans = find("div", "timeline-spans");
  const timelinePlayhead = find("span", "timeline-playhead");
  const timelineHover = find("span", "timeline-hover");
  const timelineClip = find("span", "timeline-clip");
  const timelineTicks = find("div", "timeline-ticks");
  const idleText = find("p", "player-idle");
  const pickText = idleText?.textContent.trim() ?? "";
  const cameraOnlyKey = find("span", "timeline-legend-camera");

  const timeline =
    timelineTrack === null ||
    timelineSpans === null ||
    timelinePlayhead === null ||
    timelineHover === null ||
    timelineClip === null ||
    timelineTicks === null
      ? undefined
      : timelineFor(
          {
            track: timelineTrack,
            spans: timelineSpans,
            playhead: timelinePlayhead,
            hover: timelineHover,
            clip: timelineClip,
            ticks: timelineTicks,
          },
          // A click plays every camera from there, or from the next
          // recording after a gap; in the recording already playing, it seeks.
          // Any click clears the last one's note
          (second) => {
            const at = (recording: Recording) =>
              secondOfDay(recording.begin) <= second &&
              secondOfDay(recording.end) > second;

            hideNote();

            // A clip only on the camera doesn't skip on to a later recording
            if (!recordings.some(at) && listed.some(at)) {
              showNote(
                "That clip is only on the camera's SD card, and this camera doesn't share those. Kestrel's own recordings of it play as usual",
              );

              return;
            }

            const hit = recordingAt(second);

            if (hit === undefined) return;

            const from = Math.max(second - secondOfDay(hit.begin), 0);
            const playing = player?.clip();

            if (
              playing !== undefined &&
              playing.camera === hit.camera &&
              playing.begin === hit.begin
            ) {
              player?.seek(from);
              player?.resume();
            } else {
              playClip(hit, from);
            }
          },
        );

  const spanOf = (recording: Recording): TimelineSpan => {
    const reason =
      recording.reasons.find((found) => found !== "normal") ?? "normal";

    return {
      start: secondOfDay(recording.begin),
      end: secondOfDay(recording.end),
      tone: reasonTones[reason],
      title: `${clock(recording.begin)} to ${clock(recording.end)}, ${recording.reasons.join(", ")}${recording.playable === false ? ", only on the camera's SD card, which it doesn't share" : ""}`,
      muted: recording.playable === false,
    };
  };

  const showPlayhead = () => {
    const clip = player?.clip();
    const offset = player?.offset();

    timeline?.playhead(
      clip !== undefined && offset !== undefined && onTimeline(clip)
        ? secondOfDay(clip.begin) + offset
        : undefined,
    );
  };

  // The clip: Cut marks its start, then its end, which saves it. The fields
  // show it and can be typed in, and Download clip saves it again

  /** A clip field's time as `HH:MM:SS`, taking `9:05` or `21:05:30`; empty when it isn't a time. */
  const fieldClock = (field: HTMLElementTagNameMap["gw-input"]) => {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(field.value.trim());

    const [hours = 0, minutes = 0, rest = 0] = (match?.slice(1) ?? []).map(
      (part) => Number(part ?? 0),
    );

    const valid = match !== null && hours < 24 && minutes < 60 && rest < 60;

    field.error = valid || field.value === "" ? "" : "Use HH:MM:SS";

    return valid
      ? [hours, minutes, rest]
          .map((part) => String(part).padStart(2, "0"))
          .join(":")
      : "";
  };

  /** The clip the fields give, on the picked day, if they make one. */
  const markedClip = (): Clip | undefined => {
    if (clipFrom === null || clipTo === null) return undefined;

    const from = fieldClock(clipFrom);
    const to = fieldClock(clipTo);
    const begin = `${day}T${from}`;
    const end = `${day}T${to}`;

    return from !== "" && to !== "" && end > begin
      ? { camera, begin, end }
      : undefined;
  };

  const showClip = () => {
    const clip = markedClip();

    if (clipDownload !== null) {
      clipDownload.disabled = clip === undefined;

      if (clip === undefined) clipDownload.removeAttribute("href");
      else clipDownload.setAttribute("href", clipUrl(clip, true));
    }

    timeline?.clip(
      clip === undefined ? undefined : secondOfDay(clip.begin),
      clip === undefined ? undefined : secondOfDay(clip.end),
    );
  };

  for (const field of [clipFrom, clipTo]) {
    field?.addEventListener("input", showClip);
  }

  /**
   * On a phone, the controls left out of the bar, in the More menu, as they
   * stand: Cut's item says which end of the clip a press marks.
   */
  const showMore = () => {
    if (moreMenu === null) return;

    const idle = player?.clip() === undefined;

    moreMenu.items = [
      {
        value: "next-event",
        label: "Next event",
        icon: icons.nextEvent,
        disabled: spans.length === 0,
      },
      {
        value: "events",
        label: "Events only",
        icon: icons.eventsOnly,
        checked: eventsOnly,
      },
      { value: "stop", label: "Stop", icon: icons.stop, disabled: idle },
      {
        value: "frame",
        label: "Next frame",
        icon: icons.frame,
        disabled: idle,
      },
      {
        value: "cut",
        label: cutButton?.pressed === true ? "End the clip here" : "Cut a clip",
        icon: icons.cut,
        disabled: idle,
      },
      {
        value: "download",
        label: "Download this recording",
        icon: icons.download,
        disabled: idle,
      },
    ];
  };

  moreMenu?.setAttribute("icon", phDotsThreeVertical);

  if (moreMenu !== null) {
    on(moreMenu, "select", (event) => {
      const href = downloadButton?.getAttribute("href");

      if (event.detail.value === "stop") stopButton?.click();
      else if (event.detail.value === "frame") frameButton?.click();
      else if (event.detail.value === "next-event") nextEventButton?.click();
      else if (event.detail.value === "events") eventsButton?.click();
      else if (event.detail.value === "cut") cutButton?.click();
      else if (event.detail.value === "download" && href) save(href);
    });
  }

  cutButton?.addEventListener("click", () => {
    const time = player?.time();

    if (time === undefined || clipFrom === null || clipTo === null) return;

    // First press: the clip starts here. Second: it ends here, and saves
    if (cutButton.pressed) {
      clipTo.value = clock(time);
      showClip();

      const clip = markedClip();

      if (clip !== undefined) save(clipUrl(clip, true));
    } else {
      clipFrom.value = clock(time);
      clipTo.value = "";
      showClip();
    }

    cutButton.pressed = !cutButton.pressed;
    showMore();
  });

  // The controls

  const setIcon = (
    button: HTMLElementTagNameMap["gw-button"] | null,
    icon: string,
    label?: string,
  ) => {
    // Play and Pause lead, larger and on a round filled button, as System
    // Bridge's media controls do
    const main = button === playButton;

    button?.setAttribute("icon", icon);
    button?.setAttribute("labels", "hide");
    button?.setAttribute("appearance", main ? "accent" : "plain");
    button?.setAttribute("variant", main ? "brand" : "neutral");
    button?.setAttribute("size", main ? "large" : "medium");

    if (label !== undefined) button?.setAttribute("label", label);

    if (button !== null) {
      button.textContent = button.getAttribute("label") ?? "";
    }
  };

  setIcon(playButton, icons.play);
  setIcon(stopButton, icons.stop);
  setIcon(frameButton, icons.frame);
  setIcon(previousButton, icons.previous);
  setIcon(nextButton, icons.next);
  setIcon(nextEventButton, icons.nextEvent);
  setIcon(eventsButton, icons.eventsOnly);
  setIcon(cutButton, icons.cut);
  setIcon(captureButton, icons.capture);
  setIcon(downloadButton, icons.download);
  setIcon(zoomOutButton, icons.zoomOut);
  setIcon(zoomInButton, icons.zoomIn);
  setIcon(fullscreenButton, icons.fullscreen);
  setIcon(previousDay, phCaretLeft, "Previous day");
  setIcon(nextDay, phCaretRight, "Next day");
  previousDay?.setAttribute("appearance", "outlined");
  nextDay?.setAttribute("appearance", "outlined");

  /** Shows what's playing, or the idle screen, on the controls. */
  showState = () => {
    const clip = player?.clip();
    const idle = clip === undefined;
    const playing = player !== undefined && !player.paused() && !idle;

    stage?.toggleAttribute("data-idle", idle);

    if (playButton !== null) {
      setIcon(
        playButton,
        playing ? icons.pause : icons.play,
        playing ? "Pause (K)" : "Play (K)",
      );
      playButton.disabled = idle && recordings.length === 0;
    }

    for (const button of [
      stopButton,
      frameButton,
      previousButton,
      nextButton,
      cutButton,
      captureButton,
      downloadButton,
    ]) {
      if (button !== null) button.disabled = idle;
    }

    if (cutButton !== null && idle) cutButton.pressed = false;

    // The events are there to skip to from the start, with nothing playing
    if (nextEventButton !== null) nextEventButton.disabled = spans.length === 0;

    if (downloadButton !== null) {
      if (clip === undefined) downloadButton.removeAttribute("href");
      else downloadButton.setAttribute("href", clipUrl(clip, true));
    }

    if (caption !== null) {
      caption.hidden = idle;
      caption.textContent =
        clip === undefined
          ? ""
          : `${ticked.length > 1 && !alone ? `${ticked.length} cameras` : cameraLabel(clip.camera)} · ${dayFormat.format(localDate(clip.begin))} · ${clock(clip.begin)} to ${clock(clip.end)}${
              // The sub stream, or past the browser's fastest, key frames only
              shownView.stream === "sub"
                ? " · sub stream"
                : shownView.every === undefined
                  ? ""
                  : " · key frames"
            }`;
    }

    if (idle && playerClock !== null) playerClock.textContent = "--:--:--";

    showMore();
  };

  playClip = (clip, from, autoplay = true) => {
    if (player === undefined) return;

    hideNote();

    void player.play(clip, from, autoplay).then(() => keepPosition(true));
    showState();
  };

  const togglePlay = () => {
    if (player === undefined) return;

    const first = recordings[0];

    if (player.clip() === undefined) {
      // Events only starts at the day's first event
      const firstEvent = eventsOnly ? spans[0] : undefined;

      if (firstEvent !== undefined) playFrom(firstEvent.start);
      else if (first !== undefined) playClip(first);
    } else if (player.paused()) {
      player.resume();
    } else {
      player.pause();
    }
  };

  playButton?.addEventListener("click", togglePlay);

  stopButton?.addEventListener("click", () => {
    player?.stop();
    keepPosition(true);
    showState();
    showPlayhead();
  });

  frameButton?.addEventListener("click", () => player?.step(frameSeconds));

  /**
   * The next recording to start on any playing camera, or the one before
   * the recording keeping the time, as the recorder's client skips.
   */
  const skip = (step: -1 | 1) => {
    const clip = player?.clip();
    const offset = player?.offset();

    if (clip === undefined || offset === undefined) return;

    const target =
      step === 1
        ? nextMoment(tracks, toSeconds(clip.begin) + offset)
        : previousMoment(tracks, toSeconds(clip.begin));

    const hit = recordings.find(
      (recording) => toSeconds(recording.begin) === target,
    );

    if (hit !== undefined) playClip(hit);
  };

  previousButton?.addEventListener("click", () => skip(-1));
  nextButton?.addEventListener("click", () => skip(1));

  /** The recorder second the playhead is at, if anything's loaded. */
  const playhead = () => {
    const clip = player?.clip();
    const offset = player?.offset();

    return clip === undefined || offset === undefined
      ? undefined
      : toSeconds(clip.begin) + offset;
  };

  /** Plays every camera from a recorder second: a seek within what's playing, else the recording there. */
  const playFrom = (at: number) => {
    const clip = player?.clip();

    skipping = { to: at, since: Date.now() };

    if (
      clip !== undefined &&
      toSeconds(clip.begin) <= at &&
      at < toSeconds(clip.end)
    ) {
      player?.seek(at - toSeconds(clip.begin));
      player?.resume();

      return;
    }

    const hit =
      recordings.find(
        (recording) =>
          toSeconds(recording.begin) <= at && at < toSeconds(recording.end),
      ) ?? recordings.find((recording) => toSeconds(recording.begin) > at);

    if (hit !== undefined) {
      playClip(hit, Math.max(at - toSeconds(hit.begin), 0));
    }
  };

  /** On to the next event, or back to this one's start or the one before, from a little ahead of it. */
  const skipEvent = (step: -1 | 1) => {
    const at = playhead() ?? -Infinity;
    const span = step === 1 ? nextSpan(spans, at) : previousSpan(spans, at);

    if (span !== undefined) playFrom(span.start);
  };

  /**
   * With Events only, playing past an event goes on to the next, and after
   * the day's last it stops. A skip on its way is left to get there.
   */
  const followEvents = () => {
    const at = playhead();

    if (!eventsOnly || at === undefined || player?.paused() !== false) return;

    if (skipping !== undefined) {
      const arrived = Math.abs(at - skipping.to) < 2;

      // A load that never comes is given up on
      if (!arrived && Date.now() - skipping.since < 10_000) return;

      skipping = undefined;
    }

    if (spans.length === 0 || spanAt(spans, at) !== undefined) return;

    const next = nextSpan(spans, at);

    if (next === undefined) player.pause();
    else playFrom(next.start);
  };

  const setEventsOnly = (on: boolean) => {
    eventsOnly = on;
    keep(storageKey, { eventsOnly });

    if (eventsButton !== null) eventsButton.pressed = on;

    followEvents();
    showMore();
  };

  nextEventButton?.addEventListener("click", () => skipEvent(1));
  eventsButton?.addEventListener("click", () => setEventsOnly(!eventsOnly));

  if (eventsButton !== null) eventsButton.pressed = eventsOnly;

  const showSpeed = () => {
    // Alone, the picked camera has the recorder's full stream to itself
    const view = viewFor(Number(speed), alone ? 1 : ticked.length);
    // What's left of the speed after the server's part
    const rate = Number(speed) / view.speedUp;

    // The default carries the speed over to the next recording played, and
    // to the reload a change of view brings
    player?.rate(rate);

    // The caption names the stream it plays from
    shownView = view;

    player?.view(view);
    showState();

    // The toggle marks a preset, or Custom, named for the speed, for any
    // other. The field shows the speed, unless it's being typed in
    const preset = speeds.includes(speed);
    const customLabel = preset ? "Custom" : speedLabel(speed);

    if (speedToggle !== null) {
      // Not while it's typed in, as new options would take the popover's
      // anchor away; it's named once the popover closes
      if (
        customLabel !== shownCustomLabel &&
        speedOther?.matches(":focus-within") !== true
      ) {
        const focused = speedToggle.matches(":focus-within");

        speedToggle.options = [
          ...speeds.map((value) => ({ value, label: speedLabel(value) })),
          { value: customSpeed, label: customLabel },
        ];
        shownCustomLabel = customLabel;

        if (focused) {
          void speedToggle.updateComplete.then(() => speedToggle.focus());
        }
      }

      speedToggle.value = preset ? speed : customSpeed;
    }

    if (speedOther !== null && !speedOther.matches(":focus-within")) {
      speedOther.value = speed;
    }
  };

  const setSpeed = (next: string) => {
    speed = next;
    keep(storageKey, { speed });
    showSpeed();
  };

  if (speedToggle !== null) {
    on(speedToggle, "change", () => {
      if (speedToggle.value !== customSpeed) setSpeed(speedToggle.value);
    });
    // Custom opens its field each time it's picked, beside it
    on(speedToggle, "pick", (event) => {
      if (event.detail.value === customSpeed) {
        speedCustom?.show(speedToggle.optionFor(customSpeed));
      }
    });
  }

  // Closed with no other speed typed, the toggle goes back to the speed
  // playing
  speedCustom?.addEventListener("close", () => {
    if (speedOther !== null) speedOther.value = speed;

    showSpeed();
  });

  // A speed in range takes effect as it's typed. One out of range is pulled
  // into it on leaving the field, rather than shown as an error line
  speedOther?.addEventListener("input", () => {
    const typed = Number(speedOther.value);

    if (speedOther.value !== "" && isSpeed(typed)) setSpeed(String(typed));
  });

  speedOther?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") speedCustom?.close();
  });

  speedOther?.addEventListener("focusout", () => {
    const typed = Number(speedOther.value);

    if (speedOther.value === "" || isSpeed(typed)) return;

    const held = String(
      Number.isFinite(typed) ? Math.min(Math.max(typed, slowest), fastest) : 1,
    );

    speedOther.value = held;
    setSpeed(held);
  });

  showSpeed();

  captureButton?.addEventListener("click", () => {
    const time = player?.time();
    const clip = player?.clip();

    // The picked camera's picture, or the one keeping the time when the
    // picked one has nothing then
    const shot =
      player?.lead()?.readyState === undefined ||
      player.lead()?.readyState === 0
        ? player?.video()
        : player.lead();

    if (shot === undefined || time === undefined || clip === undefined) return;

    const cameraShown = shot.closest("figure")?.dataset.camera ?? clip.camera;

    const canvas = element("canvas");

    canvas.width = shot.videoWidth;
    canvas.height = shot.videoHeight;
    canvas.getContext("2d")?.drawImage(shot, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob === null) return;

        const href = URL.createObjectURL(blob);

        save(href, `${fileName(cameraShown)}_${time.replaceAll(":", "-")}.jpg`);
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
      },
      "image/jpeg",
      0.92,
    );
  });

  // The zoom, as on the Live page, but only for this visit: each camera's
  // starts whole next time
  const views = new Map<string, PictureView>();

  const zoomTileOf = (tile: GroupTile): ZoomTile => ({
    id: tile.camera,
    figure: tile.figure,
    parts: [tile.video],
    // The sub stream's squeezed picture is stretched to fill its tile
    size: () =>
      grid?.dataset.stream === "sub"
        ? tile.figure.getBoundingClientRect()
        : { width: tile.video.videoWidth, height: tile.video.videoHeight },
  });

  const zoom = pictureZoom({
    area: grid,
    tiles: () => (player?.tiles() ?? []).map(zoomTileOf),
    picked: () => {
      const tile = player?.tiles().find((each) => each.camera === camera);

      return tile === undefined ? undefined : zoomTileOf(tile);
    },
    views: () => views,
    zoomOut: zoomOutButton,
    zoomFit: zoomFitButton,
    zoomIn: zoomInButton,
    fit: fitToggle,
  });

  /** Shows the picked camera alone, or every ticked camera again, as Live does. */
  const setAlone = (on: boolean) => {
    const next = on && ticked.length > 1;

    if (next === alone) return;

    alone = next;
    player?.solo(alone);
    showSpeed();
    zoom.show();
    showState();
  };

  /** The View menu, as Live's: only with several cameras to tile. */
  const showView = () => {
    if (viewMenu === null) return;

    viewMenu.hidden = ticked.length < 2;
    viewMenu.items = tilingModes.map((each) => ({
      ...each,
      group: "Tiling",
      checked: each.value === (smart ? "smart" : "fixed"),
    }));
  };

  const setTiling = (next: TilingMode) => {
    smart = next === "smart";
    keep(storageKey, { tiling: next });
    player?.tile(smart);
    zoom.show();
    showView();
  };

  viewMenu?.setAttribute("icon", phSquaresFour);

  if (viewMenu !== null) {
    on(viewMenu, "select", (event) => {
      const chosen = tilingModes.find(
        (each) => each.value === event.detail.value,
      );

      if (chosen !== undefined) setTiling(chosen.value);
    });
  }

  player?.tile(smart);

  // Smart tiling follows the space the cameras have, as the window's size
  // changes or they go full screen
  if (screen !== null) {
    new ResizeObserver(() => {
      if (!smart) return;

      player?.tile(smart);
      zoom.show();
    }).observe(screen);
  }

  /** Picks the camera `step` along the ticked ones, alone or not. */
  const stepCamera = (step: -1 | 1) => {
    const index = ticked.indexOf(camera);
    const next = ticked[(index + step + ticked.length) % ticked.length];

    if (ticked.length > 1 && next !== undefined) pickCamera(next);
  };

  // A press that doesn't move plays or pauses; a drag moves a zoomed picture.
  // A double click's second press doesn't, and the double click puts back
  // what its first did
  let press: { x: number; y: number; moved: boolean } | undefined;
  let lastPress = 0;
  let pressToggled = false;

  screen?.addEventListener("pointerdown", (event) => {
    press = { x: event.clientX, y: event.clientY, moved: false };
    screen.setPointerCapture(event.pointerId);
  });

  screen?.addEventListener("pointermove", (event) => {
    if (press === undefined) return;

    const x = event.clientX - press.x;
    const y = event.clientY - press.y;

    if (Math.hypot(x, y) > 4) press.moved = true;
  });

  screen?.addEventListener("pointerup", (event) => {
    // A press on another camera's tile picks that camera instead
    const tile = event
      .composedPath()
      .find(
        (target) =>
          target instanceof HTMLElement && target.matches(".player-tile"),
      );

    const onOther =
      tile instanceof HTMLElement && tile.dataset.camera !== camera;

    const second = event.timeStamp - lastPress < doublePress;

    lastPress = event.timeStamp;

    if (!second) {
      pressToggled = press !== undefined && !press.moved && !onOther;

      if (pressToggled) togglePlay();
    }

    press = undefined;
  });

  screen?.addEventListener("pointercancel", () => {
    press = undefined;
  });

  // With several cameras, a double click shows the one clicked alone, and
  // back, as on Live; with one, it goes full screen
  screen?.addEventListener("dblclick", (event) => {
    if (pressToggled) {
      pressToggled = false;
      togglePlay();
    }

    if (ticked.length < 2) {
      fullscreenButton?.click();

      return;
    }

    const tile = event
      .composedPath()
      .find(
        (target) =>
          target instanceof HTMLElement && target.matches(".player-tile"),
      );

    const clicked =
      tile instanceof HTMLElement ? tile.dataset.camera : undefined;

    if (clicked !== undefined && clicked !== camera) pickCamera(clicked);

    setAlone(!alone);
  });

  // The video, its controls and the timeline go full screen together
  fullscreenButton?.addEventListener("click", () => {
    if (document.fullscreenElement === null) {
      void view?.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const full = document.fullscreenElement !== null;

    setIcon(
      fullscreenButton,
      full ? icons.exitFullscreen : icons.fullscreen,
      full ? "Exit full screen (F)" : "Full screen (F)",
    );

    // The picture's size changed, so the pan's reach did too
    requestAnimationFrame(zoom.show);
  });

  zoom.show();

  showTime = () => {
    const time = player?.time();

    if (playerClock !== null && time !== undefined) {
      playerClock.textContent = timeFormat.format(localDate(time));
    }

    showPlayhead();
    keepPosition();
    followEvents();
  };

  if (timelineZoom !== null) {
    timelineZoom.options = timelineZooms;
    timelineZoom.value = saved.timelineZoom;
    timeline?.zoom(Number(saved.timelineZoom));
    on(timelineZoom, "change", () => {
      keep(storageKey, { timelineZoom: timelineZoom.value });
      timeline?.zoom(Number(timelineZoom.value));
    });
  }

  // The day and cameras, the month's recorded days, and the day's table

  /** The table's columns, with each recording's camera when several play. */
  const showColumns = () => {
    if (table === null) return;

    table.columns = [
      actionsColumn((clip) => {
        playClip(clip);
        stage?.scrollIntoView({ behavior: "smooth", block: "start" });
        // The keys then work the player, not the row's button
        stage?.focus({ preventScroll: true });
      }),
      ...(ticked.length > 1 ? [{ id: "cameraLabel", header: "Camera" }] : []),
      { id: "begin", header: "Start" },
      { id: "end", header: "End" },
      { id: "length", header: "Length", sortable: false },
      { id: "reasons", header: "Why", cell: reasonChips, wide: true },
      { id: "where", header: "Where" },
      {
        id: "bytes",
        header: "Size",
        numeric: true,
        cell: (row: TableRow) => String(row.size),
      },
    ];
  };

  showColumns();

  /** A camera's recordings on a day. */
  const recordingsOn = (id: CameraId, date: string) =>
    call((api) =>
      api.cameras.recordings({ params: cameraParts(id), query: { date } }),
    );

  /** Each playing camera's recordings on the picked day, into the players, the timeline and the table. */
  const showRecordings = async () => {
    if (day === "") return;

    const date = day;

    // One camera's list that can't be read shows as nothing recorded, rather
    // than holding the others, or a camera just added, loading
    const lists = await Promise.all(
      ticked.map((id) =>
        recordingsOn(id, date)
          .catch((): ReadonlyArray<Recording> => [])
          .then((list) => ({
            camera: id,
            recordings: list.toSorted((a, b) => a.begin.localeCompare(b.begin)),
          })),
      ),
    );

    // A later pick has moved on
    if (date !== day) return;

    // What can't be played is listed and drawn, but never played
    tracks = lists.map((track) => ({
      camera: track.camera,
      recordings: track.recordings.filter(
        (recording) => recording.playable !== false,
      ),
    }));

    recordings = tracks
      .flatMap((track) => track.recordings)
      .toSorted((a, b) => a.begin.localeCompare(b.begin));

    spans = eventSpans(tracks);

    showColumns();

    listed = lists
      .flatMap((track) => track.recordings)
      .toSorted((a, b) => a.begin.localeCompare(b.begin));

    if (table !== null) table.rows = listed.map(recordingRow);

    if (idleText !== null) {
      idleText.textContent =
        ticked.length === 0
          ? "Pick cameras to watch their recordings"
          : recordings.length === 0 && listed.length > 0
            ? "These recordings are only on the camera's SD card, and this camera doesn't share those"
            : pickText;
    }

    if (cameraOnlyKey !== null) {
      cameraOnlyKey.hidden = !listed.some(
        (recording) => recording.playable === false,
      );
    }

    player?.setCameras(tracks, camera);
    showView();
    timeline?.show(
      lists.map((track) => ({
        label: cameraLabel(track.camera),
        spans: track.recordings.map(spanOf),
      })),
    );
    showSpeed();
    zoom.show();
    showPlayhead();
    showClip();
    showState();
  };

  /** The address for a day, on the cameras playing, with `lead` picked; or none. */
  const searchFor = (date: string, lead = camera): RecordingsSearch =>
    lead === ""
      ? { cameras: [], date }
      : {
          camera: lead,
          ...(ticked.length > 1 && { cameras: ticked }),
          date,
        };

  /** Asks the address for the picked day, on these cameras. */
  const pick = (date: string) => options.onPick(searchFor(date));

  /** The days with recordings on any camera in a month, such as `2026-11`. */
  const recordedDaysIn = async (month: string) =>
    (
      await call((api) => api.recordings.days({ query: { month } })).catch(
        () => [],
      )
    ).map((recorded) => recorded.date);

  // The calendar's days with recordings, kept as months are browsed
  const markedDays = new Set<string>();

  const markDays = (days: ReadonlyArray<string>) => {
    for (const recorded of days) markedDays.add(recorded);

    if (dayPicker !== null) dayPicker.marked = [...markedDays];
  };

  const showDays = (days: ReadonlyArray<string>) => {
    recordedDays?.replaceChildren(
      ...days.map((recorded) => {
        const chip = element("gw-chip", recorded.slice(8));

        chip.setAttribute("tone", recorded === day ? "accent" : "neutral");
        chip.addEventListener("click", () => pick(recorded));

        return chip;
      }),
    );
  };

  /** The cameras with recordings on the day shown, once known. */
  let recordedCameras: ReadonlySet<CameraId> | undefined;

  /** The camera picker, with cameras that recorded nothing that day greyed out. */
  const showCameras = () => {
    if (cameraSelect === null) return;

    cameraSelect.options = cameras.map((each) => {
      const empty =
        recordedCameras !== undefined && !recordedCameras.has(each.id);

      return {
        value: each.id,
        label: cameraLabel(each.id),
        ...(empty && {
          description: "Nothing recorded this day",
          disabled: true,
        }),
      };
    });

    cameraSelect.values = [...ticked];
  };

  /** Finds which cameras recorded on a day: a quick search of each. */
  const findRecordedCameras = async (date: string) => {
    const found = await Promise.all(
      cameras.map((each) =>
        recordingsOn(each.id, date)
          .then((list) => (list.length > 0 ? [each.id] : []))
          // Unknown, so left to pick
          .catch(() => [each.id]),
      ),
    );

    // A later pick has moved on
    if (date !== day) return;

    recordedCameras = new Set(found.flat());
    showCameras();
  };

  /** Where a camera comes in the picker, so ticked ones play in that order. */
  const placeOf = (id: CameraId) => cameras.findIndex((each) => each.id === id);

  const inOrder = (ids: ReadonlyArray<CameraId>) =>
    ids.toSorted((a, b) => placeOf(a) - placeOf(b));

  /** The same cameras, in any order. */
  const sameCameras = (
    a: ReadonlyArray<CameraId>,
    b: ReadonlyArray<CameraId>,
  ) => a.length === b.length && a.every((id) => b.includes(id));

  /** Shows cameras and a day: the month's recorded days and the day's recordings. */
  const show = async (picked: {
    camera: CameraId;
    cameras: ReadonlyArray<CameraId>;
    date: string;
  }) => {
    // Other cameras ticked show them all
    if (!sameCameras(picked.cameras, ticked)) {
      alone = false;
      player?.solo(false);
    }

    const before = ticked;
    const sameDay = picked.date === day;

    camera = picked.camera;
    ticked = picked.cameras;
    day = picked.date;
    keep(storageKey, { camera, cameras: [...ticked], date: day });

    // On the same day, the cameras ticked show at once, those just added
    // shimmering on the player and the timeline until their recordings come,
    // and those unticked go
    const added = ticked.filter((id) => !before.includes(id));

    if (sameDay && !sameCameras(before, ticked)) {
      player?.setCameras(
        ticked.map(
          (id) =>
            tracks.find((track) => track.camera === id) ?? {
              camera: id,
              recordings: [],
            },
        ),
        camera,
        added,
      );
      timeline?.show(
        ticked.map((id) => ({
          label: cameraLabel(id),
          spans: listed
            .filter((recording) => recording.camera === id)
            .map(spanOf),
          loading: added.includes(id),
        })),
      );
      showView();
      zoom.show();
      showState();
    }

    if (cameraSelect !== null) cameraSelect.values = [...ticked];

    // Recordings stop at the last day, so there's no day after it to go to
    if (dayPicker !== null) {
      dayPicker.value = day;
      dayPicker.max = lastDay;
    }

    if (nextDay !== null) nextDay.disabled = lastDay !== "" && day >= lastDay;

    // The recordings don't wait on the month's days
    const shown = showRecordings();
    const days = await recordedDaysIn(day.slice(0, 7));

    showDays(days);
    markDays(days);
    void findRecordedCameras(day);
    await shown;
  };

  /** The day `by` days from the picked one. */
  const shiftDay = (by: number) => {
    const date = localDate(day);

    date.setDate(date.getDate() + by);

    return isoDay(date);
  };

  if (dayPicker !== null) {
    // In the browser's own language, as the page's other dates are, rather
    // than the page's plain "en", which reads as US English
    dayPicker.locale = navigator.languages[0] ?? "";

    on(dayPicker, "change", () => {
      if (dayPicker.value !== "") pick(dayPicker.value);
    });

    // Another month in the calendar marks its days with recordings too
    on(dayPicker, "month", (event) => {
      void recordedDaysIn(event.detail.month).then(markDays);
    });
  }

  previousDay?.addEventListener("click", () => {
    if (day !== "") pick(shiftDay(-1));
  });

  nextDay?.addEventListener("click", () => {
    if (day !== "") pick(shiftDay(1));
  });

  // Ticking cameras plays them together; the picked one stays picked while
  // it's ticked. The layouts stop at four, so a fifth unticks the first
  // ticked. Clear, or unticking the last, leaves none
  if (cameraSelect !== null) {
    cameraSelect.multiple = true;

    // Ctrl, Alt or Cmd with a click or Enter picks that camera alone, the
    // rest unticked, as a file list's own picking goes
    let alonePick = false;

    for (const type of ["pointerdown", "keydown"] as const) {
      cameraSelect.addEventListener(
        type,
        (event) => {
          alonePick = event.ctrlKey || event.altKey || event.metaKey;
        },
        true,
      );
    }

    on(cameraSelect, "change", () => {
      const toggled = [
        ...cameraSelect.values.filter((value) => !ticked.includes(value)),
        ...ticked.filter((value) => !cameraSelect.values.includes(value)),
      ];

      const only = alonePick && toggled.length === 1 ? toggled[0] : undefined;

      alonePick = false;

      if (only !== undefined && placeOf(only) !== -1) {
        cameraSelect.close();
        options.onPick({ camera: only, date: day });

        return;
      }

      const picks = cameraSelect.values
        .filter((value) => placeOf(value) !== -1)
        .slice(-mostCameras);

      if (picks.length === 0) {
        options.onPick({ cameras: [], date: day });

        return;
      }

      options.onPick({
        camera: picks.includes(camera) ? camera : (picks[0] ?? camera),
        ...(picks.length > 1 && { cameras: inOrder(picks) }),
        date: day,
      });
    });
  }

  pickCamera = (picked) => options.onPick(searchFor(day, picked));

  /** Shows what the address asks for, filling in what it leaves out. */
  const follow = async (search: RecordingsSearch) => {
    const known = (id: CameraId | undefined): id is CameraId =>
      id !== undefined && placeOf(id) !== -1;

    // An address with no cameras at all, as Clear leaves, plays none
    if (search.camera === undefined && search.cameras?.length === 0) {
      const date = search.date ?? day;

      if (date !== day || ticked.length > 0) {
        await show({ camera: "", cameras: [], date });
      }

      return;
    }

    // The address's camera, or the kept one, or the first with recordings
    const lead = [search.camera, saved.camera].find(known) ?? cameras[0]?.id;

    if (lead === undefined) return;

    // The address's cameras, or the kept ones when it names none, or the
    // picked one alone; always with the picked one, and only cameras there are
    const asked =
      search.cameras ??
      (search.camera === undefined ? saved.cameras : undefined) ??
      [];

    const set = inOrder(
      [...new Set([lead, ...asked])].filter(known).slice(0, mostCameras),
    );

    const wanted = {
      camera: lead,
      cameras: set,
      date: search.date ?? saved.date ?? lastDay,
    };

    if (wanted.date !== day || !sameCameras(wanted.cameras, ticked)) {
      await show(wanted);
    } else if (wanted.camera !== camera) {
      // Another of the same cameras picked: it moves first, with no reload
      camera = wanted.camera;
      keep(storageKey, { camera });
      player?.setCameras(tracks, camera);
      zoom.show();
      showState();
    }

    if (search.at !== undefined && search.at !== playedAt) {
      // A time to play from, such as a clip from the Events page
      playedAt = search.at;

      const hit = recordingAt(secondOfDay(search.at));

      if (hit !== undefined) {
        playClip(
          hit,
          Math.max(secondOfDay(search.at) - secondOfDay(hit.begin), 0),
        );
      }
    } else if (!resumed && player?.clip() === undefined) {
      // Back where it was last time, paused, when it's on this day
      const position = saved.position;

      const playable =
        position !== undefined &&
        recordings.some(
          (recording) =>
            recording.camera === position.camera &&
            recording.begin === position.begin,
        );

      if (position !== undefined && playable && onTimeline(position)) {
        playClip(position, position.offset, false);
      }
    }

    resumed = true;
  };

  // Keyboard controls, as YouTube's: they work anywhere on the page but in a
  // field being typed in, and leave the arrows to the speed toggle and the
  // table when either has the focus
  const page = stage?.closest("section");

  /** Moves the playhead by `by` seconds, within the recording. */
  const seekBy = (by: number) => {
    const clip = player?.clip();
    const offset = player?.offset();

    if (clip === undefined || offset === undefined) return;

    const length = toSeconds(clip.end) - toSeconds(clip.begin);

    player?.seek(Math.min(Math.max(offset + by, 0), length - 1));
  };

  /** The preset `step` along from the nearest one to the speed now. */
  const stepSpeed = (step: -1 | 1) => {
    const now = Number(speed);
    const nearest = speeds.findIndex((preset) => Number(preset) >= now);
    const index = (nearest === -1 ? speeds.length - 1 : nearest) + step;
    const next = speeds[Math.min(Math.max(index, 0), speeds.length - 1)];

    if (next !== undefined) setSpeed(next);
  };

  const keys = new Map<string, () => void>([
    [" ", togglePlay],
    ["k", togglePlay],
    ["ArrowLeft", () => seekBy(-5)],
    ["ArrowRight", () => seekBy(5)],
    ["Shift+ArrowLeft", () => seekBy(-30)],
    ["Shift+ArrowRight", () => seekBy(30)],
    ["j", () => seekBy(-10)],
    ["l", () => seekBy(10)],
    [".", () => frameButton?.click()],
    ["n", () => skip(1)],
    ["p", () => skip(-1)],
    ["[", () => stepSpeed(-1)],
    ["]", () => stepSpeed(1)],
    ["+", () => zoom.step(1)],
    ["=", () => zoom.step(1)],
    ["-", () => zoom.step(-1)],
    ["0", zoom.whole],
    ["z", zoom.toggleFill],
    ["f", () => fullscreenButton?.click()],
    ["c", () => cutButton?.click()],
    ["s", () => captureButton?.click()],
    ["?", () => helpButton?.click()],
    // Several cameras, as on Live: the picked one alone and back, and the
    // previous or next one picked
    ["Enter", () => setAlone(!alone)],
    ["Escape", () => setAlone(false)],
    ["Backspace", () => setAlone(false)],
    ["PageUp", () => stepCamera(-1)],
    ["PageDown", () => stepCamera(1)],
    ["t", () => setTiling(smart ? "fixed" : "smart")],
    ["w", () => skipEvent(-1)],
    ["e", () => skipEvent(1)],
    ["o", () => setEventsOnly(!eventsOnly)],
  ]);

  document.addEventListener("keydown", (event) => {
    if (page?.hidden !== false) return;

    const key = controlKey(event);
    const action = keys.get(key ?? "");

    // Enter on a control presses it, and Esc and Backspace are left alone
    // unless there's a camera alone to go back from
    const onControl = event.target !== stage && event.target !== document.body;

    if (
      action === undefined ||
      (key === "Enter" && (onControl || ticked.length < 2)) ||
      ((key === "Escape" || key === "Backspace") && !alone)
    ) {
      return;
    }

    event.preventDefault();
    action();
  });

  // Today's newest recording is still being made, as one from a camera
  // recording all the time is, so the list is read again now and then and it
  // runs on up to now, while the page shows
  let refreshing = false;

  setInterval(() => {
    if (
      refreshing ||
      page?.hidden !== false ||
      document.hidden ||
      day !== isoDay(new Date())
    ) {
      return;
    }

    refreshing = true;

    void showRecordings()
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }, refreshEvery);

  // Each control's key, in its tooltip and for assistive technology
  const shortcuts: ReadonlyArray<
    readonly [HTMLElementTagNameMap["gw-button"] | null, string, string]
  > = [
    [frameButton, ".", "."],
    [previousButton, "P", "p"],
    [nextButton, "N", "n"],
    [nextEventButton, "E", "e"],
    [eventsButton, "O", "o"],
    [cutButton, "C", "c"],
    [captureButton, "S", "s"],
    [zoomOutButton, "−", "-"],
    [zoomInButton, "+", "+"],
    [fullscreenButton, "F", "f"],
    [helpButton, "?", "?"],
  ];

  for (const [button, shown, key] of shortcuts) {
    if (button === null) continue;

    const label = `${button.getAttribute("label") ?? ""} (${shown})`;

    setIcon(button, button.getAttribute("icon") ?? "", label);
    button.setAttribute("aria-keyshortcuts", key);
  }

  playButton?.setAttribute("aria-keyshortcuts", "Space k");

  // A click on a control hands the focus back to the player, so the keys
  // keep working rather than going to the button clicked. Fields keep it
  // while they're typed in, and the keyboard's own Tab moves it as ever
  const focusPlayer = () => stage?.focus({ preventScroll: true });

  stage?.addEventListener("pointerup", (event) => {
    const path = event
      .composedPath()
      .filter((target) => target instanceof Element);

    if (path.some((target) => target.matches(`${typingTargets}, gw-popover`))) {
      return;
    }

    requestAnimationFrame(focusPlayer);
  });

  // The help button, or ?, opens the keys by the button and shuts them again
  setIcon(helpButton, phQuestion);
  helpToggle(find("gw-popover", "shortcuts"), helpButton);

  showState();

  return {
    start: (today, list) => {
      lastDay = today;
      cameras = list;

      showCameras();

      if (waiting !== undefined) void follow(waiting);

      waiting = undefined;

      // Cameras that went, such as a source's once it's turned off, stop
      // playing, and the address leaves them out
      const left = ticked.filter((id) => placeOf(id) !== -1);

      if (left.length < ticked.length && day !== "") {
        const lead = left.includes(camera) ? camera : (left[0] ?? list[0]?.id);

        if (lead !== undefined) {
          options.onPick({
            camera: lead,
            ...(left.length > 1 && { cameras: left }),
            date: day,
          });
        }
      }
    },
    open: (search) => {
      if (cameras.length === 0) waiting = search;
      else void follow(search);
    },
    pause: () => {
      player?.pause();
      keepPosition(true);
    },
    focus: focusPlayer,
  };
};
