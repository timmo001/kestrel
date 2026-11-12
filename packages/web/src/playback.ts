/**
 * The Recordings page, laid out as the recorder's own client lays out
 * playback: the video, a row of controls under it, then the day's timeline,
 * filling the window, with the clip and the day's recordings below. Play,
 * Stop, a frame at a time, the recordings either side, speed, Cut for a
 * clip, Capture for a still and Download, then the recorder's clock, zoom
 * and full screen. The channel and day come from the address; where it was,
 * its speed and both zooms are kept in this browser for next time.
 */
import {
  LocalDate,
  LocalTime,
  type Recording,
} from "@timmo001/dvr-revival-rsnet/domain";
import { on, type TableRow } from "@timmo001/groundwork-ui";
import { isText, keep, keptAt } from "@timmo001/groundwork-ui/kept.ts";
import { Option, Schema } from "effect";
import { call } from "./api.ts";
import {
  phCamera,
  phCaretLeft,
  phCaretLineRight,
  phCaretRight,
  phCornersIn,
  phCornersOut,
  phDownloadSimple,
  phMagnifyingGlassMinus,
  phMagnifyingGlassPlus,
  phPause,
  phPlay,
  phScissors,
  phSkipBack,
  phSkipForward,
  phStop,
  phX,
} from "./icons.ts";
import {
  clipUrl,
  fullView,
  playerFor,
  toSeconds,
  type Clip,
  type View,
} from "./player.ts";
import type { RecordingsSearch } from "./router.ts";
import {
  actionsColumn,
  clock,
  dayFormat,
  element,
  find,
  isoDay,
  localDate,
  reasonChips,
  reasonTones,
  recordingRow,
  seconds,
  timeFormat,
} from "./shared.ts";
import { timelineFor, type TimelineSpan } from "./timeline.ts";

// Phosphor's regular icons, as Upkeep uses
const icons = {
  play: phPlay,
  pause: phPause,
  stop: phStop,
  frame: phCaretLineRight,
  previous: phSkipBack,
  next: phSkipForward,
  cut: phScissors,
  capture: phCamera,
  download: phDownloadSimple,
  zoomIn: phMagnifyingGlassPlus,
  zoomOut: phMagnifyingGlassMinus,
  fullscreen: phCornersOut,
  exitFullscreen: phCornersIn,
};

/** The speeds on the toggle; any other is typed in beside it. */
const speeds = ["0.5", "1", "2", "4", "8", "16", "32"];

const slowest = 0.1;
const fastest = 32;

/** The fastest a browser plays a video: Chrome stops at 16. */
const browserFastest = 16;

/**
 * What a speed plays from. Up to the browser's fastest, the full stream at
 * that rate. Past it, the sub stream sped up by the server, which downloads
 * fast enough where the full one can't keep up, at a rate the browser can.
 */
const viewFor = (speed: number): View => {
  const speedUp = Math.ceil(speed / browserFastest);

  return speedUp > 1 ? { stream: "sub", speedUp } : fullView;
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

/** How far the picture zooms in, a step at a time. */
const pictureZooms = [1, 1.5, 2, 3, 4, 6, 8];

/** The main stream's frame rate, for a step of one frame. */
const frameSeconds = 1 / 15;

const daySeconds = 24 * 60 * 60;

/** How often where it's playing is kept, in milliseconds. */
const keepEvery = 2000;

/** Where this page's settings are kept, as Upkeep keeps its pages'. */
const storageKey = "dvr-revival.recordings";

/** Where it was playing: a recording and the seconds into it. */
const Position = Schema.Struct({
  channel: Schema.Int,
  begin: LocalTime,
  end: LocalTime,
  offset: Schema.Finite,
});

const decodePosition = Schema.decodeUnknownOption(Position);
const isDate = Schema.is(LocalDate);

/** What's kept, each part checked, since anyone can edit it. */
const kept = () => {
  const values = keptAt(storageKey);
  const channel = Number(values?.["channel"]);
  const date = values?.["date"];
  const speed = values?.["speed"];
  const timelineZoom = values?.["timelineZoom"];
  const pictureZoom = Number(values?.["pictureZoom"]);

  return {
    channel: Number.isInteger(channel) && channel >= 1 ? channel : undefined,
    date: isDate(date) ? date : undefined,
    speed: isText(speed) && isSpeed(Number(speed)) ? speed : "1",
    timelineZoom:
      isText(timelineZoom) &&
      timelineZooms.some((zoom) => zoom.value === timelineZoom)
        ? timelineZoom
        : "86400",
    pictureZoom: pictureZooms.includes(pictureZoom) ? pictureZoom : 1,
    position: Option.getOrUndefined(decodePosition(values?.["position"])),
  };
};

/** Starts a file download from a link. */
const save = (href: string, name?: string) => {
  const link = element("a");

  link.href = href;
  link.download = name ?? "";
  link.click();
};

export interface PlaybackOptions {
  /** Asks to show a channel and day: the page follows once the address does. */
  readonly onPick: (search: RecordingsSearch) => void;
}

export interface PlaybackPage {
  /** The recorder's channels, and its last day, which is the default one. */
  readonly start: (today: string, channels: number) => void;
  /** Shows what the address asks for: a channel, a day and a time to play. */
  readonly open: (search: RecordingsSearch) => void;
  /** Pauses, for when the page is left. */
  readonly pause: () => void;
}

/** The Recordings page, wired to its elements. */
export const playbackPage = (options: PlaybackOptions): PlaybackPage => {
  const dayButton = find("gw-button", "day");
  const dayInput = find("input", "day-input");
  const previousDay = find("gw-button", "day-previous");
  const nextDay = find("gw-button", "day-next");
  const channelSelect = find("gw-select", "channel");
  const recordedDays = find("gw-row", "recorded-days");
  const table = find("gw-table", "recordings");
  const video = find("video", "player-video");
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
  const speedToggle = find("gw-segmented", "control-speed");
  const speedOther = find("gw-input", "control-speed-other");
  const speedClear = find("gw-button", "control-speed-clear");
  const cutButton = find("gw-button", "control-cut");
  const captureButton = find("gw-button", "control-capture");
  const downloadButton = find("gw-button", "control-download");
  const zoomOutButton = find("gw-button", "control-zoom-out");
  const zoomFitButton = find("gw-button", "control-zoom-fit");
  const zoomInButton = find("gw-button", "control-zoom-in");
  const fullscreenButton = find("gw-button", "control-fullscreen");
  const clipFrom = find("gw-input", "clip-from");
  const clipTo = find("gw-input", "clip-to");
  const clipDownload = find("gw-button", "clip-download");
  const timelineZoom = find("gw-segmented", "timeline-zoom");

  const saved = kept();
  let lastDay = "";
  let channels = 0;
  let day = "";
  let channel = 1;
  let speed = saved.speed;

  /** What the address asked for before the channels were known. */
  let waiting: RecordingsSearch | undefined;

  /** The last `at` played, so the same address doesn't play it again. */
  let playedAt: string | undefined;

  /** Whether the kept position has been offered, which is once. */
  let resumed = false;

  /** The picked day's recordings on the picked channel, earliest first. */
  let recordings: ReadonlyArray<Recording> = [];

  const showProblem = (message: string) => {
    if (problem === null) return;

    problem.textContent = `Video stopped: ${message}`;
    problem.hidden = false;
  };

  /** Set below: the recording before or after `clip` on its channel. */
  let neighbour: (
    clip: Clip,
    step: -1 | 1,
  ) => Promise<Recording | undefined> = async () => undefined;

  /** Set below: loads a recording from `from` seconds in, playing unless told not to. */
  let playClip: (clip: Clip, from?: number, autoplay?: boolean) => void = () =>
    undefined;

  const player =
    video === null
      ? undefined
      : playerFor(video, {
          onProblem: showProblem,
          // Runs on into the next recording, as the recorder's client does
          onEnded: async (ended) => {
            const next = await neighbour(ended, 1);

            if (next !== undefined && player?.clip() === ended) playClip(next);
          },
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
              channel: clip.channel,
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

  /** Whether `clip` is on the day and channel the timeline shows. */
  const onTimeline = (clip: Clip) =>
    clip.channel === channel && clip.begin.slice(0, 10) === day;

  /** The recording at a second of the picked day, or the next one after it. */
  const recordingAt = (second: number) =>
    recordings.find((recording) => secondOfDay(recording.end) > second);

  const timelineTrack = find("div", "timeline-track");
  const timelineSpans = find("div", "timeline-spans");
  const timelinePlayhead = find("span", "timeline-playhead");
  const timelineHover = find("span", "timeline-hover");
  const timelineClip = find("span", "timeline-clip");
  const timelineTicks = find("div", "timeline-ticks");

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
          // A click plays the recording under it from there, or the next
          // one after a gap; in the recording already playing, it seeks
          (second) => {
            const hit = recordingAt(second);

            if (hit === undefined) return;

            const from = Math.max(second - secondOfDay(hit.begin), 0);
            const playing = player?.clip();

            if (
              playing !== undefined &&
              playing.channel === hit.channel &&
              playing.begin === hit.begin
            ) {
              player?.seek(from);
              void video?.play().catch(() => undefined);
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
      title: `${clock(recording.begin)} to ${clock(recording.end)}, ${recording.reasons.join(", ")}`,
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
      ? { channel, begin, end }
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
  setIcon(cutButton, icons.cut);
  setIcon(captureButton, icons.capture);
  setIcon(downloadButton, icons.download);
  setIcon(zoomOutButton, icons.zoomOut);
  setIcon(zoomInButton, icons.zoomIn);
  setIcon(fullscreenButton, icons.fullscreen);
  setIcon(speedClear, phX);
  speedClear?.setAttribute("size", "small");
  setIcon(previousDay, phCaretLeft, "Previous day");
  setIcon(nextDay, phCaretRight, "Next day");
  previousDay?.setAttribute("appearance", "outlined");
  nextDay?.setAttribute("appearance", "outlined");

  /** Shows what's playing, or the idle screen, on the controls. */
  const showState = () => {
    const clip = player?.clip();
    const idle = clip === undefined;
    const playing = video !== null && !video.paused && !idle;

    stage?.toggleAttribute("data-idle", idle);

    if (playButton !== null) {
      setIcon(
        playButton,
        playing ? icons.pause : icons.play,
        playing ? "Pause" : "Play",
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

    if (downloadButton !== null) {
      if (clip === undefined) downloadButton.removeAttribute("href");
      else downloadButton.setAttribute("href", clipUrl(clip, true));
    }

    if (caption !== null) {
      caption.hidden = idle;
      caption.textContent =
        clip === undefined
          ? ""
          : `Channel ${clip.channel} · ${dayFormat.format(localDate(clip.begin))} · ${clock(clip.begin)} to ${clock(clip.end)}${
              // Past the browser's fastest, it's the sub stream
              Number(speed) > browserFastest ? " · sub stream" : ""
            }`;
    }

    if (idle && playerClock !== null) playerClock.textContent = "--:--:--";
  };

  playClip = (clip, from, autoplay = true) => {
    if (player === undefined) return;

    if (problem !== null) problem.hidden = true;

    void player.play(clip, from, autoplay).then(() => keepPosition(true));
    showState();
  };

  const togglePlay = () => {
    if (video === null) return;

    const first = recordings[0];

    if (player?.clip() === undefined) {
      if (first !== undefined) playClip(first);
    } else if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  playButton?.addEventListener("click", togglePlay);

  stopButton?.addEventListener("click", () => {
    player?.stop();
    keepPosition(true);
    showState();
    showPlayhead();
  });

  frameButton?.addEventListener("click", () => {
    if (video === null) return;

    video.pause();
    video.currentTime += frameSeconds;
  });

  const skip = async (step: -1 | 1) => {
    const clip = player?.clip();

    if (clip === undefined) return;

    const next = await neighbour(clip, step);

    if (next !== undefined) playClip(next);
  };

  previousButton?.addEventListener("click", () => void skip(-1));
  nextButton?.addEventListener("click", () => void skip(1));

  const showSpeed = () => {
    const view = viewFor(Number(speed));
    // What's left of the speed after the server's part
    const rate = Number(speed) / view.speedUp;

    if (video !== null) {
      // The default carries the speed over to the next recording played,
      // and to the reload a change of view brings
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    }

    player?.view(view);
    showState();

    // The toggle marks a preset, and the field shows whichever speed it is,
    // unless it's being typed in or stepped, which it's left to
    if (speedToggle !== null) {
      speedToggle.value = speeds.includes(speed) ? speed : "";
    }

    if (speedOther !== null && !speedOther.matches(":focus-within")) {
      speedOther.value = speed;
    }

    if (speedClear !== null) speedClear.hidden = speedOther?.value === "";
  };

  const setSpeed = (next: string) => {
    speed = next;
    keep(storageKey, { speed });
    showSpeed();
  };

  if (speedToggle !== null) {
    speedToggle.options = speeds.map((value) => ({
      value,
      label: speedLabel(value),
    }));
    on(speedToggle, "change", () => setSpeed(speedToggle.value));
  }

  // A speed in range takes effect as it's typed. One out of range is pulled
  // into it on leaving the field, rather than shown as an error line that
  // would push the timeline down
  speedOther?.addEventListener("input", () => {
    const typed = Number(speedOther.value);

    // Emptied, it's back to normal speed
    if (speedOther.value === "") setSpeed("1");
    else if (isSpeed(typed)) setSpeed(String(typed));
    else showSpeed();
  });

  speedClear?.addEventListener("click", () => {
    setSpeed("1");

    if (speedOther !== null) speedOther.value = "";

    if (speedClear !== null) speedClear.hidden = true;
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

    if (video === null || time === undefined || clip === undefined) return;

    const canvas = element("canvas");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob === null) return;

        const href = URL.createObjectURL(blob);

        save(href, `channel-${clip.channel}_${time.replaceAll(":", "-")}.jpg`);
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
      },
      "image/jpeg",
      0.92,
    );
  });

  // Zoom: in steps from the buttons, or at the pointer with the wheel, and
  // panned by dragging the picture. The level is kept; the pan isn't
  let zoom = saved.pictureZoom;
  let pan = { x: 0, y: 0 };

  const showZoom = () => {
    const box = screen?.getBoundingClientRect();
    const reachX = ((zoom - 1) * (box?.width ?? 0)) / 2;
    const reachY = ((zoom - 1) * (box?.height ?? 0)) / 2;

    pan = {
      x: Math.min(Math.max(pan.x, -reachX), reachX),
      y: Math.min(Math.max(pan.y, -reachY), reachY),
    };

    if (video !== null) {
      video.style.transform =
        zoom === 1 ? "" : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    }

    screen?.toggleAttribute("data-zoomed", zoom > 1);

    if (zoomFitButton !== null) {
      zoomFitButton.textContent = `${Math.round(zoom * 100)}%`;
      zoomFitButton.disabled = zoom === 1;
    }

    if (zoomOutButton !== null) zoomOutButton.disabled = zoom === 1;

    if (zoomInButton !== null) {
      zoomInButton.disabled = zoom === pictureZooms.at(-1);
    }
  };

  /** Zooms to `next`, keeping the point at `at` (from the picture's centre) where it is. */
  const zoomTo = (next: number, at = { x: 0, y: 0 }) => {
    pan = {
      x: at.x - ((at.x - pan.x) / zoom) * next,
      y: at.y - ((at.y - pan.y) / zoom) * next,
    };
    zoom = next;
    keep(storageKey, { pictureZoom: zoom });
    showZoom();
  };

  const zoomStep = (step: -1 | 1, at?: { x: number; y: number }) => {
    const index = pictureZooms.indexOf(zoom) + step;

    const next =
      pictureZooms[Math.min(Math.max(index, 0), pictureZooms.length - 1)];

    if (next !== undefined && next !== zoom) zoomTo(next, at);
  };

  zoomInButton?.addEventListener("click", () => zoomStep(1));
  zoomOutButton?.addEventListener("click", () => zoomStep(-1));
  zoomFitButton?.addEventListener("click", () => zoomTo(1));

  /** A pointer's place from the picture's centre. */
  const fromCentre = (event: MouseEvent) => {
    const box = screen?.getBoundingClientRect();

    return {
      x: event.clientX - ((box?.left ?? 0) + (box?.width ?? 0) / 2),
      y: event.clientY - ((box?.top ?? 0) + (box?.height ?? 0) / 2),
    };
  };

  // A wheel's notch or a trackpad's swipe comes as a run of small events, so
  // they add up to a step at a time rather than each taking one
  const wheelStep = 100;
  let wheeled = 0;

  screen?.addEventListener(
    "wheel",
    (event) => {
      if (player?.clip() === undefined) return;

      event.preventDefault();
      wheeled += event.deltaY;

      if (Math.abs(wheeled) < wheelStep) return;

      zoomStep(wheeled < 0 ? 1 : -1, fromCentre(event));
      wheeled = 0;
    },
    { passive: false },
  );

  // A press that doesn't move plays or pauses; a drag pans a zoomed picture
  let press:
    { x: number; y: number; pan: typeof pan; moved: boolean } | undefined;

  screen?.addEventListener("pointerdown", (event) => {
    press = { x: event.clientX, y: event.clientY, pan, moved: false };
    screen.setPointerCapture(event.pointerId);
  });

  screen?.addEventListener("pointermove", (event) => {
    if (press === undefined) return;

    const x = event.clientX - press.x;
    const y = event.clientY - press.y;

    if (Math.hypot(x, y) > 4) press.moved = true;

    if (press.moved && zoom > 1) {
      pan = { x: press.pan.x + x, y: press.pan.y + y };
      showZoom();
    }
  });

  screen?.addEventListener("pointerup", () => {
    if (press !== undefined && !press.moved) togglePlay();

    press = undefined;
  });

  screen?.addEventListener("pointercancel", () => {
    press = undefined;
  });

  screen?.addEventListener("dblclick", () => fullscreenButton?.click());

  fullscreenButton?.addEventListener("click", () => {
    if (document.fullscreenElement === null) {
      void stage?.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const full = document.fullscreenElement !== null;

    setIcon(
      fullscreenButton,
      full ? icons.exitFullscreen : icons.fullscreen,
      full ? "Exit full screen" : "Full screen",
    );

    // The picture's size changed, so the pan's reach did too
    requestAnimationFrame(showZoom);
  });

  showZoom();

  for (const type of ["play", "pause", "emptied"]) {
    video?.addEventListener(type, showState);
  }

  video?.addEventListener("timeupdate", () => {
    const time = player?.time();

    if (playerClock !== null && time !== undefined) {
      playerClock.textContent = timeFormat.format(localDate(time));
    }

    showPlayhead();
    keepPosition();
  });

  if (timelineZoom !== null) {
    timelineZoom.options = timelineZooms;
    timelineZoom.value = saved.timelineZoom;
    timeline?.zoom(Number(saved.timelineZoom));
    on(timelineZoom, "change", () => {
      keep(storageKey, { timelineZoom: timelineZoom.value });
      timeline?.zoom(Number(timelineZoom.value));
    });
  }

  // The day and channel, the month's recorded days, and the day's table

  if (table !== null) {
    table.columns = [
      actionsColumn((clip) => {
        playClip(clip);
        stage?.scrollIntoView({ behavior: "smooth", block: "start" });
      }),
      { id: "begin", header: "Start" },
      { id: "end", header: "End" },
      { id: "length", header: "Length", sortable: false },
      { id: "reasons", header: "Why", cell: reasonChips, wide: true },
      {
        id: "bytes",
        header: "Size",
        numeric: true,
        cell: (row: TableRow) => String(row.size),
      },
    ];
  }

  const showRecordings = async () => {
    if (day === "") return;

    const list = await call((api) =>
      api.recorder.recordings({ query: { channel, date: day } }),
    );

    recordings = list.toSorted((a, b) => a.begin.localeCompare(b.begin));

    if (table !== null) table.rows = list.map(recordingRow);

    timeline?.show(recordings.map(spanOf));
    showPlayhead();
    showClip();
    showState();
  };

  // The recordings either side come from the server's list for the clip's
  // own day and channel, as the page may show another by now
  neighbour = async (clip, step) => {
    const list = onTimeline(clip)
      ? recordings
      : await call((api) =>
          api.recorder.recordings({
            query: { channel: clip.channel, date: clip.begin.slice(0, 10) },
          }),
        )
          .then((found) =>
            found.toSorted((a, b) => a.begin.localeCompare(b.begin)),
          )
          .catch((): ReadonlyArray<Recording> => []);

    // Back-to-back files start the second the last one ends
    return step === 1
      ? list.find(
          (recording) => toSeconds(recording.begin) > toSeconds(clip.end) - 2,
        )
      : list.findLast(
          (recording) => toSeconds(recording.end) < toSeconds(clip.begin) + 2,
        );
  };

  /** Asks the address for the picked day, on this channel. */
  const pick = (date: string) => options.onPick({ channel, date });

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

  /** Shows a channel and day: the month's recorded days and the day's recordings. */
  const show = async (picked: { channel: number; date: string }) => {
    channel = picked.channel;
    day = picked.date;
    keep(storageKey, { channel, date: day });

    if (channelSelect !== null) channelSelect.value = String(channel);

    if (dayInput !== null) dayInput.value = day;

    if (dayButton !== null) {
      dayButton.textContent = dayFormat.format(localDate(day));
    }

    // Recordings stop at the last day, so there's no day after it to go to
    if (nextDay !== null) nextDay.disabled = lastDay !== "" && day >= lastDay;

    const days = await call((api) =>
      api.recorder.days({ query: { month: day.slice(0, 7) } }),
    ).catch(() => []);

    showDays(days.map((recorded) => recorded.date));
    await showRecordings();
  };

  /** The day `by` days from the picked one. */
  const shiftDay = (by: number) => {
    const date = localDate(day);

    date.setDate(date.getDate() + by);

    return isoDay(date);
  };

  dayButton?.addEventListener("click", () => {
    if (dayInput === null) return;

    if (lastDay !== "") dayInput.max = lastDay;

    // The calendar opens from the click; where a browser can't, focus the input
    try {
      dayInput.showPicker();
    } catch {
      dayInput.focus();
    }
  });

  dayInput?.addEventListener("change", () => {
    if (dayInput.value !== "") pick(dayInput.value);
  });

  previousDay?.addEventListener("click", () => {
    if (day !== "") pick(shiftDay(-1));
  });

  nextDay?.addEventListener("click", () => {
    if (day !== "") pick(shiftDay(1));
  });

  if (channelSelect !== null) {
    on(channelSelect, "change", () =>
      options.onPick({ channel: Number(channelSelect.value), date: day }),
    );
  }

  /** Shows what the address asks for, filling in what it leaves out. */
  const follow = async (search: RecordingsSearch) => {
    const wanted = {
      channel: Math.min(search.channel ?? saved.channel ?? 1, channels),
      date: search.date ?? saved.date ?? lastDay,
    };

    if (wanted.channel !== channel || wanted.date !== day) await show(wanted);

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

      if (position !== undefined && onTimeline(position)) {
        playClip(position, position.offset, false);
      }
    }

    resumed = true;
  };

  showState();

  return {
    start: (today, count) => {
      lastDay = today;
      channels = count;

      if (channelSelect !== null) {
        channelSelect.options = Array.from({ length: count }, (_, index) => ({
          value: String(index + 1),
          label: `Channel ${index + 1}`,
        }));
      }

      if (waiting !== undefined) void follow(waiting);

      waiting = undefined;
    },
    open: (search) => {
      if (channels === 0) waiting = search;
      else void follow(search);
    },
    pause: () => {
      video?.pause();
      keepPosition(true);
    },
  };
};
