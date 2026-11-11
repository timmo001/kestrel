/**
 * The page script: Base's fonts, the theme CSS and the components, then the
 * recorder's health, live view, recordings and events from the server. The
 * service worker keeps the shell so the app starts offline.
 */
import "@fontsource-variable/mona-sans";
import "@fontsource-variable/geist-mono";
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
  LiveStream,
  ReceivedEvent,
} from "@timmo001/dvr-revival-server/api";
import { connectPwa } from "@timmo001/groundwork-pwa/view";
import { coreThemeChoices, pageTheme } from "@timmo001/groundwork-tokens/page";
import { on, type TableRow } from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import config from "../pwa.config.ts";
import { call, listenForEvents } from "./api.ts";
import { themeOptions } from "./theme.ts";

// Base only, with the mode following the system, until the app's themes are
// chosen (timmo001/dvr-revival#7)
pageTheme({
  ...themeOptions,
  themes: coreThemeChoices.filter(({ id }) => id === themeOptions.defaultTheme),
});

connectPwa(config);

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

// Connection: the chip in the bar, and the banner while the server can't
// reach the recorder
const connectionChip = find("gw-chip", "connection");
const offline = find("gw-banner", "offline");

const offlineMessage = document.querySelector("p.offline-message");

const showConnection = async () => {
  const connection = await call((api) => api.recorder.connection()).catch(
    () => null,
  );

  const connected = connection?.connected === true;

  if (connectionChip !== null) {
    connectionChip.loading = false;
    connectionChip.textContent = connected ? "Connected" : "Disconnected";
    connectionChip.setAttribute("tone", connected ? "success" : "danger");
  }

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
  const [device, status] = await Promise.all([
    call((api) => api.recorder.device()),
    call((api) => api.recorder.status()),
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
        value: status.time?.replace("T", " ") ?? "Unknown",
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
    disksCard.replaceChildren(row);
  }

  if (channelsTable !== null) {
    channelsTable.rows = status.channels.map(channelRow);
  }

  return status.channels;
};

// Live: one go2rtc player per channel that has a signal
const liveGrid = find("gw-grid", "live");

const showLive = async (channels: ReadonlyArray<ChannelStatus>) => {
  const sources = await call((api) => api.video.sources());

  const withSignal = new Set(
    channels.flatMap((status) => (status.videoLoss ? [] : [status.channel])),
  );

  const player = (stream: LiveStream) => {
    const card = element("gw-card");
    const frame = element("iframe");

    card.setAttribute("heading", stream.name);
    frame.className = "live-frame";
    frame.title = `${stream.name} live`;
    frame.loading = "lazy";
    frame.src = `${location.protocol}//${location.hostname}:${sources.go2rtcPort}/stream.html?src=${stream.sub}&mode=mse`;
    card.append(frame);

    return card;
  };

  liveGrid?.replaceChildren(
    ...sources.streams
      .filter((stream) => withSignal.has(stream.channel))
      .map(player),
  );
};

// Recordings: a day and channel, the month's recorded days, and the clips
const dayInput = find("gw-input", "day");
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

  const days = await call((api) =>
    api.recorder.days({ query: { month: picked.slice(0, 7) } }),
  );

  showDays(days);
  await showRecordings();
};

// The input inside gw-input fires the native change, which bubbles
dayInput?.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.value !== "") {
    void pickDay(event.target.value);
  }
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
      cell: (row) => new Date(String(row.receivedAt)).toLocaleTimeString(),
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
    showLive(channels),
    pickDay(today),
    showEvents(),
    showClips(),
  ]);

  setInterval(() => {
    void showConnection().then((connected) =>
      connected ? showRecorder() : undefined,
    );
  }, 30_000);
};

void start();
