/**
 * The desktop app's main process: runs this computer's Kestrel server or
 * uses another one it's paired with, opens the server's page in a window
 * with Groundwork's desktop defaults, through the front door that signs it
 * in, and keeps running in the tray once the window closes. The tray shows
 * how the server is doing, chooses the server, shares this computer's with
 * other devices, updates the app where it no longer matches the server, and
 * opens the docs built into the app, and the page asks where they are for
 * its own docs link.
 */
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { isOlder, mismatchMessage, version } from "@timmo001/kestrel-core";
import { browse } from "@timmo001/kestrel-core/discovery";
import {
  Effect,
  FileSystem,
  ManagedRuntime,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";
import { FetchHttpClient } from "effect/http";
import Electrobun, { BrowserView } from "electrobun/main";
import {
  openDesktopWindow,
  type DesktopRequests,
  type DesktopSchema,
  type TrayItem,
} from "@timmo001/groundwork-desktop/main";

import config from "../../desktop.config.ts";
import type { AppRequests } from "../requests.ts";
import {
  readConnection,
  writeConnection,
  type Connection,
  type Remote,
} from "./connection.ts";
import { DesktopDocs } from "./docs.ts";
import { startGate } from "./gate.ts";
import { clientFor, DesktopServer, type Status } from "./server.ts";
import {
  installVersion,
  releasePage,
  updateHelp,
  updatesItself,
} from "./update.ts";

const port = Number(process.env.KESTREL_PORT ?? 7380);
const localOrigin = `http://127.0.0.1:${port}`;
const resources = join(import.meta.dir, "..");
const web = process.env.KESTREL_WEB ?? join(resources, "web");

// The go2rtc built into the app, so it runs where mise isn't on the path,
// such as at login
process.env.KESTREL_GO2RTC ??= join(
  resources,
  "go2rtc",
  process.platform === "win32" ? "go2rtc.exe" : "go2rtc",
);

// The recorder login `mise run auth:save` keeps, for a source in
// sources.json that leaves it out, as `serve:server` loads it
const saved = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const folder =
      process.env.KESTREL_CONFIG ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "kestrel",
      );

    return yield* fs.readFileString(join(folder, "recorder.env"));
  }).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.provide(BunServices.layer),
  ),
);

for (const [key, value] of Object.entries(parseEnv(saved))) {
  process.env[key] ??= value;
}

const docs = ManagedRuntime.make(DesktopDocs.layer(join(resources, "docs")));

let connection = await Effect.runPromise(
  readConnection.pipe(Effect.provide(BunServices.layer)),
);

let status: Status = { state: "starting" };

const makeRuntime = (next: Connection) =>
  ManagedRuntime.make(
    DesktopServer.layer({
      port,
      web,
      connection: next,
      moved: (found) => void switchTo(found, { reload: true }),
    }),
  );

let runtime = makeRuntime(connection);

// The origins the window's own pages come from. Groundwork keeps this list,
// so a server chosen later is added to it.
const ownOrigins: string[] = [localOrigin];

if (connection.mode === "remote") {
  ownOrigins.push(new URL(connection.server).origin);
}

// Set once the window opens
let windowView = (): BrowserView | undefined => undefined;
let notify = (_heading: string, _body: string) => {};
let refreshTray = () => {};

/** Lets the window load pages from `origin`, as it does the app's own. */
const allow = (origin: string) => {
  const own = new URL(origin).origin;

  if (ownOrigins.includes(own)) return;

  ownOrigins.push(own);
  windowView()?.setNavigationRules([
    "^*",
    "views://*",
    ...ownOrigins.map((each) => `${each}/*`),
  ]);
};

/** Keeps `status` and the tray in step with the runtime's server. */
const watch = (current: typeof runtime) =>
  current.runFork(
    Effect.gen(function* () {
      const server = yield* DesktopServer;

      yield* SubscriptionRef.changes(server.status).pipe(
        Stream.runForEach((next) =>
          Effect.sync(() => {
            // Say so once, when it starts not matching
            if (next.state === "mismatch" && status.state !== "mismatch") {
              notify(
                "Kestrel needs updating",
                mismatchMessage({
                  client: version,
                  server: next.server,
                  what: "This app",
                  where: next.name,
                }),
              );
            }

            status = next;
            refreshTray();
          }),
        ),
      );
    }),
  );

let switching = Promise.resolve();

/**
 * Uses another server, or this computer's: keeps the choice, stops the one
 * in use, then starts or reaches the new one. With `reload`, the window
 * goes to the new server's page.
 */
const switchTo = (
  next: Connection,
  options: { readonly reload: boolean },
): Promise<void> => {
  switching = switching.then(async () => {
    await Effect.runPromise(
      writeConnection(next).pipe(Effect.provide(BunServices.layer)),
    );

    connection = next;
    status = { state: "starting" };
    refreshTray();

    if (next.mode === "remote") allow(next.server);

    // This computer's server stops before another starts on its port
    await runtime.dispose();
    runtime = makeRuntime(next);
    await runtime.context();
    watch(runtime);

    if (options.reload) windowView()?.loadURL(gate.url);
  });

  return switching;
};

/** Pairs this app with the server at `server` and uses it, or says why it couldn't. */
const pair = (server: string, code: string) =>
  Effect.gen(function* () {
    if (!/^https?:\/\/./.test(server)) {
      return "Give the server's address, such as http://192.168.1.20:7380";
    }

    const client = yield* clientFor(server, Option.none());
    const info = yield* client.devices.server();

    if (info.version !== version) {
      return mismatchMessage({
        client: version,
        server: info.version,
        what: "This app",
        where: info.name,
      });
    }

    const paired = yield* client.devices.pair({
      payload: { code, name: `Desktop app on ${hostname()}`, kind: "desktop" },
    });

    if (paired.token === undefined) {
      return "The server paired this app but sent no token back";
    }

    const remote: Remote = {
      mode: "remote",
      server,
      serverId: info.id,
      name: info.name,
      token: paired.token,
    };

    yield* Effect.promise(() => switchTo(remote, { reload: false }));

    return undefined;
  }).pipe(
    Effect.catchTag("PairingRefused", () =>
      Effect.succeed(
        "That code didn't work: it may be mistyped, used or out of time. Get a new one and try again",
      ),
    ),
    Effect.catch((error) =>
      Effect.succeed(`Couldn't pair with ${server}: ${error.message}`),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.runPromise,
  );

/** Updates the app to `target` and quits, or says why it couldn't. */
const update = (target: string) =>
  updatesItself
    ? installVersion(target).pipe(
        Effect.as(undefined),
        Effect.tap(() =>
          // Long enough for the window to say it's updating
          Effect.sync(() => setTimeout(() => Electrobun.Utils.quit(0), 1500)),
        ),
        Effect.catch((error) => Effect.succeed(error.message)),
        Effect.provide([BunServices.layer, FetchHttpClient.layer]),
        Effect.runPromise,
      )
    : Promise.resolve(updateHelp);

/** The server's status now, from the runtime rather than the tray's copy. */
const currentStatus = () =>
  runtime.runPromise(
    DesktopServer.use((server) => SubscriptionRef.get(server.status)),
  );

const gate = startGate({
  // Only once the server's up, so the window doesn't open on an error page
  signIn: () =>
    currentStatus().then((now) =>
      now.state === "up" || now.state === "remote"
        ? runtime
            .runPromise(DesktopServer.use(({ signIn }) => signIn))
            .then(Option.getOrUndefined)
        : undefined,
    ),
  status: currentStatus,
  connection: () => connection,
  servers: () =>
    Effect.runPromise(browse("3 seconds").pipe(Effect.orElseSucceed(() => []))),
  pair,
  useLocal: (share) => switchTo({ mode: "local", share }, { reload: false }),
  update,
});

ownOrigins.push(gate.origin);

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

const statusLine = (current: Status): string => {
  switch (current.state) {
    case "starting":
      return "Starting…";
    case "down":
      return "Server stopped, starting again…";
    case "up":
      return [
        connection.mode === "local" && connection.share
          ? "Running, shared"
          : "Running",
        `${current.connected} of ${plural(current.sources, "source")} connected`,
        ...(current.recording > 0
          ? [`recording ${plural(current.recording, "camera")}`]
          : []),
      ].join(" · ");
    case "remote":
      return `Using ${current.name}`;
    case "unreachable":
      return `Can't reach ${current.name}`;
    case "unpaired":
      return `${current.name} unpaired this computer`;
    case "mismatch":
      return `${current.name} runs Kestrel ${current.server}, this app ${version}`;
  }
};

const trayItems = (): TrayItem[] => [
  { type: "normal", label: statusLine(status), enabled: false },
  ...(status.state === "mismatch" && isOlder(version, status.server)
    ? [
        {
          type: "normal",
          label: `Update Kestrel to ${status.server}`,
          action: "update",
        } as const,
      ]
    : []),
  { type: "divider" },
  connection.mode === "local"
    ? {
        type: "normal",
        label: "Share with other devices",
        action: "share",
        checked: connection.share,
      }
    : { type: "normal", label: "Use this computer's server", action: "local" },
  { type: "normal", label: "Use another server…", action: "choose" },
  { type: "divider" },
  { type: "normal", label: "Docs", action: "docs" },
];

const docsUrl = () => docs.runPromise(DesktopDocs.useSync(({ url }) => url));

const onTrayAction = (action: string) => {
  switch (action) {
    case "docs":
      void docsUrl().then((url) => Electrobun.Utils.openExternal(url));

      return;

    case "choose":
      desktop.show();
      windowView()?.loadURL(gate.chooseUrl);

      return;

    case "share":
      void switchTo(
        {
          mode: "local",
          share: !(connection.mode === "local" && connection.share),
        },
        { reload: true },
      );

      return;

    case "local":
      void switchTo({ mode: "local", share: false }, { reload: true });

      return;

    case "update":
      if (status.state !== "mismatch") return;

      if (updatesItself) {
        desktop.show();
        windowView()?.loadURL(gate.url);
      } else {
        Electrobun.Utils.openExternal(releasePage(status.server));
        notify("Kestrel needs updating", updateHelp);
      }
  }
};

const desktop = await openDesktopWindow(Electrobun, {
  title: "Kestrel",
  url: gate.url,
  frame: { width: 1280, height: 800 },
  config: { ...config, ownOrigins },
  // Linux takes the script itself, not a views:// address
  preload: await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      return yield* fs.readFileString(
        join(resources, "views", "preload", "index.js"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  ),
  ready: async () => {
    await runtime.context();
    watch(runtime);
  },
  trayItems: trayItems(),
  onTrayAction,
  createRPC: (requests: DesktopRequests) =>
    BrowserView.defineRPC<DesktopSchema<AppRequests>>({
      maxRequestTime: 10_000,
      handlers: { requests: { ...requests, docs: docsUrl } },
    }),
});

windowView = () => {
  const id = desktop.window?.webview.id;

  return id === undefined ? undefined : BrowserView.getById(id);
};

notify = (heading, body) => desktop.notify({ heading, body, tone: "warning" });

refreshTray = () => desktop.setTrayItems(trayItems());

refreshTray();

// Stop the server, and go2rtc with it, before the app quits: the first quit
// waits for that, then quits again
let stopped = false;

Electrobun.events.on("before-quit", (event) => {
  if (stopped) return;
  event.response = { allow: false };
  gate.stop();
  void Promise.all([runtime.dispose(), docs.dispose()]).finally(() => {
    stopped = true;
    Electrobun.Utils.quit(0);
  });
});
