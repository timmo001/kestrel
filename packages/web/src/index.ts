/**
 * The page script: Base's fonts, the theme CSS and the components, then the
 * app bar's pages (live view, recordings, events and the recorder's health),
 * one shown at a time from the address's hash. The service worker keeps the
 * shell so the app starts offline.
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
import type { ChannelStatus } from "@timmo001/dvr-revival-rsnet/domain";
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
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import config from "../pwa.config.ts";
import { call, listenForEvents } from "./api.ts";
import { phBell, phDotsThreeVertical } from "./icons.ts";
import { playbackPage } from "./playback.ts";
import { currentLocation, href, navigate, type Location } from "./router.ts";
import {
  actionsColumn,
  dateTimeFormat,
  element,
  find,
  localDate,
  reasonChips,
  recordingRow,
  timeFormat,
} from "./shared.ts";
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
// passive notes, above every page. A passive disk note, such as a full
// disk, shows in the Disks card instead.
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

  // Hidden when empty, so it leaves no gap above the page
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

// Live: a grid of each channel that has a signal, on its main stream. The
// players only run while the page shows, so a hidden page streams nothing
const liveGrid = find("div", "live-grid");
let liveChannels: ReadonlyArray<ChannelStatus> | undefined;

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

  // The page may have been left while the sources loaded
  if (currentPage !== "live") return;

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

/** Takes the players off the page, which closes their streams. */
const stopLive = () => liveGrid?.replaceChildren();

// Recordings: its own module, as the recorder's client lays out playback.
// Its channel, day and the time to play from live in the address
const playback = playbackPage({
  onPick: (search) => navigate(href("recordings", { search })),
});

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
    // Plays it on the Recordings page, on its own day and channel
    actionsColumn((clip) =>
      navigate(
        href("recordings", {
          search: {
            channel: clip.channel,
            date: clip.begin.slice(0, 10),
            at: clip.begin,
          },
        }),
      ),
    ),
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

// Pages: one shown at a time, from the router's current location, so each
// has an address of its own and back and forward move between them
type Page = Location["name"];

const pageTitles: Record<Page, string> = {
  live: "Live",
  recordings: "Recordings",
  events: "Events",
  recorder: "Recorder",
  notFound: "Page not found",
};

const pages = [...document.querySelectorAll("section.page")];
const navLinks = [...document.querySelectorAll("a.nav-link")];
let currentPage: Page | undefined;

const showPage = (location: Location) => {
  const page = location.name;
  const left = currentPage;

  // The Recordings page follows its search, such as a new day, in place
  if (location.name === "recordings") playback.open(location.search);

  if (page === left) return;

  currentPage = page;

  for (const section of pages) {
    if (section instanceof HTMLElement) {
      section.hidden = section.dataset.page !== page;
    }
  }

  for (const link of navLinks) {
    if (link instanceof HTMLElement && link.dataset.page === page) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }

  document.title = `${pageTitles[page]} · DVR Revival`;

  if (left === "live") stopLive();

  if (left === "recordings") playback.pause();

  if (page === "live" && liveChannels !== undefined) {
    void showLive(liveChannels);
  }
};

AtomRegistry.make().subscribe(currentLocation, showPage, { immediate: true });

// The app bar folds its links into its menu below `menu-below`. Set that to
// the width the brand, the links and the smallest actions need, so the links
// stay in the bar for as long as they fit beside them
const appBar = document.querySelector("gw-app-bar");
const brand = find("a", "brand");

/** The bar's padding, the gaps between its parts and the links, and the two action buttons at their smallest. */
const barExtras = 12 * 2 + 12 * 2 + 4 * (navLinks.length - 1) + 40 * 2 + 16;

/** Each link's padding either side of its text. */
const linkPadding = 12 * 2;

const fitNav = () => {
  if (appBar === null || brand === null) return;

  // The text keeps its width whether the link is in the bar or the menu
  const links = navLinks.reduce(
    (total, link) =>
      total +
      (link.querySelector("span")?.getBoundingClientRect().width ?? 0) +
      linkPadding,
    0,
  );

  appBar.menuBelow = Math.ceil(
    brand.getBoundingClientRect().width + links + barExtras,
  );
};

fitNav();

void document.fonts.ready.then(fitNav);

// A theme can change the font, and with it the links' widths
theme.subscribe(() => requestAnimationFrame(fitNav));

// Notifications: the bar's overflow menu subscribes this browser to the
// server's pushes and says where they stand, hidden where it can't push
const more = find("gw-menu-button", "more");

more?.setAttribute("icon", phDotsThreeVertical);

const bell = phBell;

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
  // The app's root, whichever page it was opened on
  service: new URL("./", document.baseURI).href,
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

  liveChannels = await showRecorder();

  playback.start(today, channelCount);

  await Promise.all([
    showAttention(),
    currentPage === "live" ? showLive(liveChannels) : undefined,
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
