/**
 * The page script, the app's shell: the fonts, the theme and the
 * components, the connection banner and what needs you, then the app bar's
 * pages (Live, Recordings, Events and Sources), one shown at a time from the
 * address, each from a module of its own. The service worker keeps the
 * shell so the app starts offline.
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
import type { Attention, Camera, SourceInfo } from "@timmo001/kestrel-core";
import {
  connectPwa,
  pushState,
  subscribePush,
  type PushState,
} from "@timmo001/groundwork-pwa/view";
import { pageTheme } from "@timmo001/groundwork-tokens/page";
import { createIcon, on, type MenuItem } from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import config from "../pwa.config.ts";
import { call } from "./api.ts";
import { loadCameras } from "./cameras.ts";
import { eventsPage } from "./events.ts";
import {
  phBell,
  phBellRinging,
  phDotsThreeVertical,
  phFilmStrip,
  phGear,
  phHardDrives,
  phVideoCamera,
} from "./icons.ts";
import { livePage } from "./live.ts";
import { recordingsPage } from "./recordings.ts";
import { currentLocation, href, navigate, type Location } from "./router.ts";
import { find } from "./shared.ts";
import { settingsPage } from "./settings.ts";
import { attentionAlert, isStorageNote, sourcesPage } from "./sources.ts";
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
// passive notes, above every page. A passive storage note, such as a full
// disk, shows in its source's Storage card instead.
const attentionStack = find("gw-stack", "attention");

const fetchAttention = (): Promise<ReadonlyArray<Attention>> =>
  call((api) => api.attention.list()).catch(() => []);

const showAttention = (all: ReadonlyArray<Attention>) => {
  const items = all.filter((item) => !isStorageNote(item));

  if (attentionStack === null) return;

  // Hidden when empty, so it leaves no gap above the page
  attentionStack.hidden = items.length === 0;
  attentionStack.replaceChildren(
    ...items
      .toSorted((a, b) =>
        a.level === b.level ? 0 : a.level === "alert" ? -1 : 1,
      )
      .map(attentionAlert),
  );
};

// Each page is a module of its own
const live = livePage();
let cameras: ReadonlyArray<Camera> | undefined;

// Recordings: its cameras, day and the time to play from live in the address
const recordings = recordingsPage({
  onPick: (search) => navigate(href("recordings", { search })),
});

// Events: a clip plays on the Recordings page, on its own day and camera
const events = eventsPage({
  onPlay: (clip) =>
    navigate(
      href("recordings", {
        search: {
          camera: clip.camera,
          date: clip.begin.slice(0, 10),
          at: clip.begin,
        },
      }),
    ),
});

const sources = sourcesPage();

/** Shows the cameras again after a save, with their new names, and any new ones. */
const reloadCameras = async () => {
  const known = await loadCameras().catch(() => cameras ?? []);

  cameras = known;
  recordings.start(
    today,
    known.filter((camera) => camera.recordings),
  );

  const list = await showConnection();

  if (list !== null) await showSources(list);

  if (currentPage === "live") await live.show(known);
};

// Settings: started on its own, so a source that can't connect can be fixed
const settings = settingsPage({ onSaved: reloadCameras });

void settings.start();

/** Today on the first source's clock where there's one, or the browser's. */
let today = "";

/** Shows what needs you and each source, and keeps today from its clock. */
const showSources = async (list: ReadonlyArray<SourceInfo>) => {
  const attention = await fetchAttention();

  showAttention(attention);

  const clock = await sources.show(list, attention);

  today = clock?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
};

// Pages: one shown at a time, from the router's current location, so each
// has an address of its own and back and forward move between them
type Page = Location["name"];

const isPage = Schema.is(
  Schema.Literals([
    "live",
    "recordings",
    "events",
    "sources",
    "settings",
    "notFound",
  ]),
);

const pageTitles: Record<Page, string> = {
  live: "Live",
  recordings: "Recordings",
  events: "Events",
  sources: "Sources",
  settings: "Settings",
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
  sources: phHardDrives,
  settings: phGear,
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
  if (location.name === "recordings") recordings.open(location.search);

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

  if (left === "recordings") recordings.pause();

  // Arriving at a player, the keyboard controls work straight away
  if (page === "recordings") requestAnimationFrame(recordings.focus);

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
    description: "Alerts about your cameras, pushed to this browser",
    icon: bell,
  },
  subscribed: {
    value: "notify",
    label: "Notifying this browser",
    description: "Alerts about your cameras are pushed here",
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
const allConnected = (list: ReadonlyArray<SourceInfo>) =>
  list.every((source) => source.connection.connected);

/** The connected sources' ids, to tell when one connects or drops. */
const connectedIds = (list: ReadonlyArray<SourceInfo>) =>
  list
    .flatMap((source) => (source.connection.connected ? [source.id] : []))
    .join(" ");

/**
 * Keeps the health fresh: often while a source is down, else every half
 * minute. A source that connects or drops brings or takes its cameras.
 */
const watchConnection = (connected: string) => {
  const delay = (list: ReadonlyArray<SourceInfo> | null) =>
    list !== null && allConnected(list) ? 30_000 : 5000;

  const check = async (): Promise<void> => {
    const next = await showConnection();

    if (next !== null && connectedIds(next) !== connected) {
      await reloadCameras();
      await events.start(
        (cameras ?? []).filter((camera) => camera.recordings),
        today,
      );

      return watchConnection(connectedIds(next));
    }

    if (next !== null) await showSources(next);

    setTimeout(() => void check(), delay(next));
  };

  setTimeout(() => void check(), 5000);
};

// Start once the server is reachable, with the cameras of the sources it
// reaches, so one that's down doesn't hold up the rest
const start = async () => {
  const list = await showConnection();

  if (list === null) {
    setTimeout(() => void start(), 5000);

    return;
  }

  // The cameras first, so every page labels them, such as "Ch 3"
  const known = await loadCameras();
  const recorded = known.filter((camera) => camera.recordings);

  await showSources(list);

  cameras = known;
  recordings.start(today, recorded);

  await Promise.all([
    currentPage === "live" ? live.show(known) : undefined,
    events.start(recorded, today),
  ]);

  watchConnection(connectedIds(list));
};

void start();
