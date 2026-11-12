/**
 * The page script: Base's fonts, the theme CSS and the components, then the
 * recorder's health, live view, recordings and events from the server. The
 * service worker keeps the shell so the app starts offline.
 */
// Every theme's fonts; a browser only downloads the ones in use
import "@fontsource-variable/mona-sans";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/jetbrains-mono";
import "@timmo001/groundwork-tokens/themes.css";
import "./index.css";
import "@timmo001/groundwork-ui";
import {
  RecordingReason,
  type ChannelStatus,
  type RecordedDay,
  type Recording,
} from "@timmo001/dvr-revival-rsnet/domain";
import type {
  Attention,
  LiveStream,
  ReceivedEvent,
} from "@timmo001/dvr-revival-server/api";
import {
  connectPwa,
  pushState,
  subscribePush,
  type PushState,
} from "@timmo001/groundwork-pwa/view";
import { pageTheme, themeOptions } from "@timmo001/groundwork-tokens/page";
import { on, type MenuItem, type TableRow } from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import config from "../pwa.config.ts";
import { call, listenForEvents } from "./api.ts";
import { themeSettings, themes } from "./theme.ts";

// The theme picker in the app bar: every Groundwork theme and mode, with
// nothing to import, so it's always one of the themes listed
const theme = pageTheme({ ...themeSettings, themes });

const isThemeMode = Schema.is(
  Schema.Literals(["auto", "light", "dark", "darker"]),
);

const themePicker = document.querySelector("gw-theme-picker");

const showTheme = () => {
  if (themePicker === null) return;

  const { mode, theme: current, only } = theme.state();

  themePicker.mode = mode;
  themePicker.theme = current;
  themePicker.scheme = only ?? "";
  themePicker.themes = themeOptions(themes);
};

theme.subscribe(showTheme);

showTheme();

if (themePicker !== null) {
  on(themePicker, "mode", (event) => {
    if (isThemeMode(event.detail.mode)) theme.setMode(event.detail.mode);
  });
  on(themePicker, "theme", (event) => theme.setTheme(event.detail.id));
}

const pwa = connectPwa(config);

const find = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
) =>
  [...document.querySelectorAll(tag)].find((found) =>
    found.classList.contains(className),
  ) ?? null;

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
) => {
  const created = document.createElement(tag);

  if (text !== undefined) created.textContent = text;

  return created;
};

const isReason = Schema.is(RecordingReason);

const reasonTones: Record<RecordingReason, string> = {
  normal: "neutral",
  manual: "info",
  alarm: "warning",
  motion: "warning",
  "alarm input": "warning",
  PIR: "important",
};

/** Chips for a row's reasons, which the row keeps as one comma-separated value. */
const reasonChips = (row: TableRow) => {
  const chips = element("gw-row");

  for (const reason of String(row.reasons ?? "").split(", ")) {
    if (!isReason(reason)) continue;

    const chip = element("gw-chip", reason);

    chip.setAttribute("tone", reasonTones[reason]);
    chips.append(chip);
  }

  return chips;
};

// Dates and times in the browser's preferred language. Chrome formats with
// its interface language by default, which can differ, such as US dates for
// someone who prefers British English.
const locales = navigator.languages;

const dayFormat = new Intl.DateTimeFormat(locales, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dateTimeFormat = new Intl.DateTimeFormat(locales, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const timeFormat = new Intl.DateTimeFormat(locales, { timeStyle: "medium" });

/**
 * A recorder time or day, such as `2026-11-12` or `2026-11-12T08:30:00`, as
 * a local `Date`: the recorder keeps its clock in local time, with no zone.
 */
const localDate = (time: string) =>
  new Date(time.length === 10 ? `${time}T00:00:00` : time);

/** A local `Date`'s day as `YYYY-MM-DD`, the form the server takes. */
const isoDay = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

const clock = (time: string) => time.slice(11, 19);

const seconds = (time: string) => {
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

/** A recording as a table row: `bytes` sorts the size column, `size` shows it. */
const recordingRow = (recording: Recording): TableRow => ({
  key: `${recording.channel}-${recording.begin}`,
  channel: recording.channel,
  begin: clock(recording.begin),
  end: clock(recording.end),
  length: duration(recording.begin, recording.end),
  reasons: recording.reasons.join(", "),
  bytes: recording.bytes,
  size: size(recording.bytes),
});

// Connection: a banner while the server can't reach the recorder, and
// nothing while it can
const offline = find("gw-banner", "offline");

const offlineMessage = document.querySelector("p.offline-message");

const showConnection = async () => {
  const connection = await call((api) => api.recorder.connection()).catch(
    () => null,
  );

  const connected = connection?.connected === true;

  if (offline !== null) offline.open = !connected;

  if (offlineMessage !== null) {
    const why =
      connection?.error === null || connection === null
        ? ""
        : `: ${connection.error}`;

    offlineMessage.textContent =
      connection === null
        ? "Can't reach the server. Trying again…"
        : `Can't reach the recorder${why}. Trying again…`;
  }

  return connected;
};

// What needs you, from the server's attention list: alerts first, then
// passive notes. A passive disk note, such as a full disk, shows in the
// Disks card instead.
const attentionStack = find("gw-stack", "attention");

const isDiskNote = (item: Attention) =>
  item.level === "passive" && item.kind === "disk";

const attentionAlert = (item: Attention) => {
  const alert = element("gw-alert", item.message);

  alert.setAttribute("tone", item.level === "alert" ? "warning" : "info");

  return alert;
};

const fetchAttention = () =>
  call((api) => api.recorder.attention()).catch(() => []);

const showAttention = async () => {
  const items = (await fetchAttention()).filter((item) => !isDiskNote(item));

  if (attentionStack === null) return;

  // Hidden when empty, so it leaves no gap above the cameras
  attentionStack.hidden = items.length === 0;
  attentionStack.replaceChildren(
    ...items
      .sort((a, b) => (a.level === b.level ? 0 : a.level === "alert" ? -1 : 1))
      .map(attentionAlert),
  );
};

// Recorder: device facts, disks and each channel's state
const deviceCard = find("gw-card", "device");
const disksCard = find("gw-card", "disks");
const channelsTable = find("gw-table", "channels");
let today = "";
let channelCount = 0;

if (channelsTable !== null) {
  channelsTable.columns = [
    { id: "channel", header: "Channel", numeric: true },
    { id: "signal", header: "Signal" },
    { id: "recording", header: "Recording" },
    { id: "motion", header: "Motion now" },
  ];
}

const channelRow = (status: ChannelStatus): TableRow => ({
  channel: status.channel,
  signal: status.videoLoss ? "No signal" : "OK",
  recording: status.recordingMode,
  motion: status.motion ? "Yes" : "No",
});

const showRecorder = async () => {
  const [device, status, attention] = await Promise.all([
    call((api) => api.recorder.device()),
    call((api) => api.recorder.status()),
    fetchAttention(),
  ]);

  channelCount = device.channels;
  today = status.time?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

  if (deviceCard !== null) {
    const facts = element("gw-facts");

    facts.items = [
      { label: "Name", value: device.name },
      { label: "Firmware", value: device.firmware },
      { label: "Channels", value: String(device.channels) },
      {
        label: "Recorder clock",
        value:
          status.time === null
            ? "Unknown"
            : dateTimeFormat.format(localDate(status.time)),
      },
    ];

    deviceCard.loading = false;
    deviceCard.replaceChildren(facts);
  }

  if (disksCard !== null) {
    const row = element("gw-row");

    for (const disk of status.disks) {
      const badge = element("gw-badge", disk.state);

      badge.setAttribute("label", `Disk ${disk.disk}`);
      badge.setAttribute("tone", disk.state === "ok" ? "success" : "warning");
      row.append(badge);
    }

    if (status.disks.length === 0) row.append(element("span", "No disks"));

    disksCard.loading = false;
    disksCard.replaceChildren(
      row,
      ...attention.filter(isDiskNote).map(attentionAlert),
    );
  }

  if (channelsTable !== null) {
    channelsTable.rows = status.channels.map(channelRow);
  }

  return status.channels;
};

// Live: a grid of each channel that has a signal, on its main stream
const liveGrid = find("div", "live-grid");

/** go2rtc's player element, as far as the page sets it up. */
interface LivePlayer extends HTMLElement {
  /** How it plays: MSE over the WebSocket, falling back to HLS. */
  mode: string;
  /** The tracks it asks for. */
  media: string;
  /** The stream's WebSocket URL; setting it connects. */
  src: string;
}

declare global {
  interface HTMLElementTagNameMap {
    "dvr-live": LivePlayer;
  }
}

/** What the page uses from go2rtc's `video-rtc.js`. */
interface VideoRtcModule {
  readonly VideoRTC: CustomElementConstructor;
}

/**
 * Defines `dvr-live` from go2rtc's own `video-rtc.js`, served beside it, so
 * the player always matches the go2rtc that sends the stream.
 */
const definePlayer = async (path: string) => {
  if (customElements.get("dvr-live") !== undefined) return;

  const url = new URL(`${path}video-rtc.js`, location.origin).href;

  const { VideoRTC }: VideoRtcModule = await import(url);

  if (customElements.get("dvr-live") === undefined) {
    customElements.define("dvr-live", VideoRTC);
  }
};

const showLive = async (channels: ReadonlyArray<ChannelStatus>) => {
  const sources = await call((api) => api.video.sources());

  await definePlayer(sources.path);

  const withSignal = new Set(
    channels.flatMap((status) => (status.videoLoss ? [] : [status.channel])),
  );

  const tiles = sources.streams.flatMap((stream: LiveStream) => {
    if (!withSignal.has(stream.channel)) return [];

    const figure = element("figure");
    const player = document.createElement("dvr-live");

    figure.className = "live-tile";
    // Shimmers until the first frames play. Media events don't bubble, so
    // the tile listens as they pass down to the player's video
    figure.dataset.loading = "";
    figure.addEventListener("playing", () => delete figure.dataset.loading, {
      capture: true,
      once: true,
    });
    player.mode = "mse,hls";
    // Video only: the recorder offers an audio track but sends nothing on it,
    // and a player waiting for that audio never starts
    player.media = "video";
    figure.append(player, element("figcaption", stream.name));

    return [{ figure, player, stream }];
  });

  liveGrid?.replaceChildren(...tiles.map(({ figure }) => figure));
  liveGrid?.removeAttribute("aria-busy");

  // Connect once they're on the page, where each player creates its video
  for (const { player, stream } of tiles) {
    player.src = new URL(
      `${sources.path}api/ws?src=${encodeURIComponent(stream.main)}`,
      location.origin,
    ).href;
  }
};

// Recordings: a day and channel, the month's recorded days, and the clips
const dayButton = find("gw-button", "day");
const dayInput = find("input", "day-input");
const previousDay = find("gw-button", "day-previous");
const nextDay = find("gw-button", "day-next");
const channelSelect = find("gw-select", "channel");
const recordedDays = find("gw-row", "recorded-days");
const recordingsTable = find("gw-table", "recordings");
let day = "";
let channel = 1;

const recordingColumns = [
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

if (recordingsTable !== null) recordingsTable.columns = recordingColumns;

const showRecordings = async () => {
  if (recordingsTable === null || day === "") return;

  const recordings = await call((api) =>
    api.recorder.recordings({ query: { channel, date: day } }),
  );

  recordingsTable.rows = recordings.map(recordingRow);
};

const showDays = (days: ReadonlyArray<RecordedDay>) => {
  recordedDays?.replaceChildren(
    ...days.map((recorded) => {
      const chip = element("gw-chip", recorded.date.slice(8));

      chip.setAttribute("tone", recorded.date === day ? "accent" : "neutral");
      chip.title = recorded.reasons.join(", ");
      chip.addEventListener("click", () => void pickDay(recorded.date));

      return chip;
    }),
  );
};

const pickDay = async (picked: string) => {
  day = picked;

  if (dayInput !== null) dayInput.value = picked;

  if (dayButton !== null) {
    dayButton.textContent = dayFormat.format(localDate(picked));
  }

  // Recordings stop at today, so there's no day after it to go to
  if (nextDay !== null) nextDay.disabled = today !== "" && picked >= today;

  const days = await call((api) =>
    api.recorder.days({ query: { month: picked.slice(0, 7) } }),
  );

  showDays(days);
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

  if (today !== "") dayInput.max = today;

  // The calendar opens from the click; where a browser can't, focus the input
  try {
    dayInput.showPicker();
  } catch {
    dayInput.focus();
  }
});

dayInput?.addEventListener("change", () => {
  if (dayInput.value !== "") void pickDay(dayInput.value);
});

previousDay?.addEventListener("click", () => {
  if (day !== "") void pickDay(shiftDay(-1));
});

nextDay?.addEventListener("click", () => {
  if (day !== "") void pickDay(shiftDay(1));
});

if (channelSelect !== null) {
  on(channelSelect, "change", () => {
    channel = Number(channelSelect.value);
    void showRecordings();
  });
}

// Events: alarm reports as they arrive, and today's motion and PIR clips
// from the recordings, which show events even if reports don't come through
const eventsTable = find("gw-table", "events");
const clipsTable = find("gw-table", "clips");

if (eventsTable !== null) {
  eventsTable.columns = [
    {
      id: "receivedAt",
      header: "Received",
      cell: (row) => timeFormat.format(new Date(String(row.receivedAt))),
    },
    { id: "kind", header: "What" },
    { id: "channel", header: "Channel", numeric: true },
    { id: "state", header: "State" },
  ];
}

const eventRow = (event: ReceivedEvent): TableRow => ({
  receivedAt: event.receivedAt,
  kind: event.kind,
  channel: event.channel,
  state: event.active === null ? "" : event.active ? "Started" : "Ended",
});

if (clipsTable !== null) {
  clipsTable.columns = [
    { id: "begin", header: "Start" },
    { id: "channel", header: "Channel", numeric: true },
    { id: "length", header: "Length", sortable: false },
    { id: "reasons", header: "Why", cell: reasonChips, wide: true },
  ];
}

const showEvents = async () => {
  const recent = await call((api) => api.events.recent());

  if (eventsTable !== null) eventsTable.rows = recent.map(eventRow);

  listenForEvents((event) => {
    if (eventsTable !== null) {
      eventsTable.rows = [eventRow(event), ...eventsTable.rows];
    }
  });
};

const showClips = async () => {
  const perChannel = await Promise.all(
    Array.from({ length: channelCount }, (_, index) =>
      call((api) =>
        api.recorder.recordings({
          query: { channel: index + 1, date: today },
        }),
      ),
    ),
  );

  if (clipsTable === null) return;

  clipsTable.rows = perChannel
    .flat()
    .filter((clip) =>
      clip.reasons.some((reason) => reason === "motion" || reason === "PIR"),
    )
    .map(recordingRow);
};

// Notifications: the bar's overflow menu subscribes this browser to the
// server's pushes and says where they stand, hidden where it can't push
const more = find("gw-menu-button", "more");

// mdi's bell-outline
const bell =
  "M10 21H14C14 22.1 13.1 23 12 23S10 22.1 10 21M21 19V20H3V19L5 17V11C5 7.9 7 5.2 10 4.3V4C10 2.9 10.9 2 12 2S14 2.9 14 4V4.3C17 5.2 19 7.9 19 11V17L21 19M17 11C17 8.2 14.8 6 12 6S7 8.2 7 11V18H17V11Z";

const notifyItems: Record<Exclude<PushState, "unsupported">, MenuItem> = {
  default: {
    value: "notify",
    label: "Notify me",
    description: "Alerts about the recorder, pushed to this browser",
    icon: bell,
  },
  subscribed: {
    value: "notify",
    label: "Notifying this browser",
    description: "Alerts about the recorder are pushed here",
    icon: bell,
    disabled: true,
  },
  denied: {
    value: "notify",
    label: "Notifications are blocked",
    description: "Allow them in this site's settings to get alerts",
    icon: bell,
    disabled: true,
  },
};

const clientKey = "dvr-revival:push-client";
const clientId = localStorage.getItem(clientKey) ?? crypto.randomUUID();

localStorage.setItem(clientKey, clientId);

const pushService = {
  service: new URL("./", location.href).href,
  client: {
    id: clientId,
    name: navigator.platform || "Browser",
    platform: "web" as const,
  },
};

const showNotify = (state: PushState) => {
  if (more === null) return;

  more.hidden = state === "unsupported";
  more.items = state === "unsupported" ? [] : [notifyItems[state]];
};

void pwa.worker.then(async (registration) => {
  showNotify(await pushState(registration));

  if (more !== null) {
    on(more, "select", async (event) => {
      if (event.detail.value === "notify") {
        showNotify(await subscribePush(registration, pushService));
      }
    });
  }
});

// Start once the recorder is reachable, then keep the health fresh
const start = async () => {
  if (!(await showConnection())) {
    setTimeout(() => void start(), 5000);

    return;
  }

  const channels = await showRecorder();

  if (channelSelect !== null) {
    channelSelect.options = Array.from(
      { length: channelCount },
      (_, index) => ({
        value: String(index + 1),
        label: `Channel ${index + 1}`,
      }),
    );
  }

  await Promise.all([
    showAttention(),
    showLive(channels),
    pickDay(today),
    showEvents(),
    showClips(),
  ]);

  setInterval(() => {
    void showAttention();
    void showConnection().then((connected) =>
      connected ? showRecorder() : undefined,
    );
  }, 30_000);
};

void start();
