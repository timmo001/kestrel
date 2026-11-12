/**
 * The page script: Base's fonts, the theme CSS and the components, then the
 * app bar's pages (live view, recordings, events and the recorder's health),
 * one shown at a time from the address. Live and Recordings have modules of
 * their own. The service worker keeps the shell so the app starts offline.
 */
// Settings saved under the app's old name, carried over before any are read
import "./renamed.ts";
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
  cameraParts,
  type Camera,
  type ChannelStatus,
  type ReceivedEvent,
  type SourceInfo,
} from "@timmo001/kestrel-core/domain";
import type { Attention } from "@timmo001/kestrel-server/api";
import {
  connectPwa,
  pushState,
  subscribePush,
  type PushState,
} from "@timmo001/groundwork-pwa/view";
import { pageTheme } from "@timmo001/groundwork-tokens/page";
import {
  createIcon,
  on,
  type MenuItem,
  type TableRow,
} from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import config from "../pwa.config.ts";
import { call, listenForEvents } from "./api.ts";
import { cameraLabel, loadCameras } from "./cameras.ts";
import {
  phBell,
  phBellRinging,
  phDotsThreeVertical,
  phFilmStrip,
  phHardDrives,
  phVideoCamera,
} from "./icons.ts";
import { livePage } from "./live.ts";
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
import {
  pickerOptions,
  themeDocuments,
  themeSettings,
  themes,
} from "./theme.ts";

// The theme picker in the app bar: Kestrel's own theme, then every Groundwork
// theme and mode, with nothing to import, so it's always one of those listed
const theme = pageTheme({
  ...themeSettings,
  themes,
  documents: themeDocuments,
});

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
  themePicker.themes = pickerOptions;
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

// Connection: a banner while the server can't reach a source, and nothing
// while it reaches them all
const offline = find("gw-banner", "offline");

const offlineMessage = document.querySelector("p.offline-message");

/** Why a source can't be reached, as the banner says it. */
const unreachable = (source: SourceInfo) =>
  `Can't reach ${source.name}${source.connection.error === null ? "" : `: ${source.connection.error}`}.`;

/** The sources, or null when the server itself can't be reached. */
const showConnection = async () => {
  const sources = await call((api) => api.sources.list()).catch(() => null);
  const down = sources?.filter((source) => !source.connection.connected) ?? [];

  if (offline !== null) offline.open = sources === null || down.length > 0;

  if (offlineMessage !== null) {
    offlineMessage.textContent =
      sources === null
        ? "Can't reach the server. Trying again…"
        : `${down.map(unreachable).join(" ")} Trying again…`;
  }

  return sources;
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
  call((api) => api.sources.attention()).catch(() => []);

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

// Recorder: device facts, disks and each channel's state, from the source
// with details, which is the recorder
const deviceCard = find("gw-card", "device");
const disksCard = find("gw-card", "disks");
const channelsTable = find("gw-table", "channels");
let today = "";

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

/** Today on the recorder's clock where there's one, or the browser's. */
const browserToday = () => new Date().toISOString().slice(0, 10);

const showRecorder = async (sources: ReadonlyArray<SourceInfo>) => {
  const recorder = sources.find((source) => source.details);

  if (recorder === undefined) {
    today = browserToday();

    return;
  }

  const params = { source: recorder.id };

  const [device, status, attention] = await Promise.all([
    call((api) => api.sources.device({ params })),
    call((api) => api.sources.status({ params })),
    fetchAttention(),
  ]);

  today = status.time?.slice(0, 10) ?? browserToday();

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
};

// Live: its own module, with its layouts and controls
const live = livePage();
let cameras: ReadonlyArray<Camera> | undefined;

// Recordings: its own module, as the recorder's client lays out playback.
// Its cameras, day and the time to play from live in the address
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
    { id: "camera", header: "Camera" },
    { id: "state", header: "State" },
  ];
}

const eventRow = (event: ReceivedEvent): TableRow => ({
  receivedAt: event.receivedAt,
  kind: event.kind,
  camera: event.camera === null ? "" : cameraLabel(event.camera),
  state: event.active === null ? "" : event.active ? "Started" : "Ended",
});

if (clipsTable !== null) {
  clipsTable.columns = [
    // Plays it on the Recordings page, on its own day and camera
    actionsColumn((clip) =>
      navigate(
        href("recordings", {
          search: {
            camera: clip.camera,
            date: clip.begin.slice(0, 10),
            at: clip.begin,
          },
        }),
      ),
    ),
    { id: "begin", header: "Start" },
    { id: "cameraLabel", header: "Camera" },
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

const showClips = async (list: ReadonlyArray<Camera>) => {
  const perCamera = await Promise.all(
    list.map((camera) =>
      call((api) =>
        api.cameras.recordings({
          params: cameraParts(camera.id),
          query: { date: today },
        }),
      ).catch(() => []),
    ),
  );

  if (clipsTable === null) return;

  clipsTable.rows = perCamera
    .flat()
    .filter((clip) =>
      clip.reasons.some((reason) => reason === "motion" || reason === "PIR"),
    )
    .map(recordingRow);
};

// Pages: one shown at a time, from the router's current location, so each
// has an address of its own and back and forward move between them
type Page = Location["name"];

const isPage = Schema.is(
  Schema.Literals(["live", "recordings", "events", "recorder", "notFound"]),
);

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

// Each link's icon, before its name
const pageIcons: Record<Page, string> = {
  live: phVideoCamera,
  recordings: phFilmStrip,
  events: phBellRinging,
  recorder: phHardDrives,
  notFound: phVideoCamera,
};

for (const link of navLinks) {
  const page = link instanceof HTMLElement ? link.dataset.page : undefined;
  const icon = pageIcons[isPage(page) ? page : "notFound"];

  link.prepend(createIcon(icon));
}

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

  document.title = `${pageTitles[page]} · Kestrel`;

  if (left === "live") live.stop();

  if (left === "recordings") playback.pause();

  // Arriving at a player, the keyboard controls work straight away
  if (page === "recordings") requestAnimationFrame(playback.focus);

  if (page === "live") requestAnimationFrame(live.focus);

  if (page === "live" && cameras !== undefined) void live.show(cameras);
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

/** Each link's icon and the gap after it. */
const linkIcon = 20 + 6;

const fitNav = () => {
  if (appBar === null || brand === null) return;

  // The text keeps its width whether the link is in the bar or the menu
  const links = navLinks.reduce(
    (total, link) =>
      total +
      (link.querySelector("span")?.getBoundingClientRect().width ?? 0) +
      linkPadding +
      linkIcon,
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

const clientKey = "kestrel:push-client";
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

/** Every source connected, so their cameras are all known. */
const allConnected = (sources: ReadonlyArray<SourceInfo> | null) =>
  sources !== null && sources.every((source) => source.connection.connected);

// Start once the sources are reachable, then keep the health fresh
const start = async () => {
  const sources = await showConnection();

  if (sources === null || !allConnected(sources)) {
    setTimeout(() => void start(), 5000);

    return;
  }

  await showRecorder(sources);

  const known = await loadCameras();
  const recorded = known.filter((camera) => camera.recordings);

  cameras = known;
  playback.start(today, recorded);

  await Promise.all([
    showAttention(),
    currentPage === "live" ? live.show(known) : undefined,
    showEvents(),
    showClips(recorded),
  ]);

  setInterval(() => {
    void showAttention();
    void showConnection().then((next) =>
      next === null ? undefined : showRecorder(next),
    );
  }, 30_000);
};

void start();
