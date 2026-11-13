/**
 * The desktop app's main process: runs the Kestrel server, opens its page in
 * a window with Groundwork's desktop defaults and keeps running in the tray
 * once the window closes. The tray shows how the server is doing and opens
 * the docs built into the app, and the page asks where they are for its own
 * docs link.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { BunServices } from "@effect/platform-bun";
import {
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Stream,
  SubscriptionRef,
} from "effect";
import Electrobun, { BrowserView } from "electrobun/main";
import {
  openDesktopWindow,
  type DesktopRequests,
  type DesktopSchema,
  type TrayItem,
} from "@timmo001/groundwork-desktop/main";

import config from "../../desktop.config.ts";
import type { AppRequests } from "../requests.ts";
import { DesktopDocs } from "./docs.ts";
import { DesktopServer, type Status } from "./server.ts";

const port = Number(process.env.KESTREL_PORT ?? 7380);
const origin = `http://127.0.0.1:${port}`;
const resources = join(import.meta.dir, "..");

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

const runtime = ManagedRuntime.make(
  Layer.merge(
    DesktopServer.layer({
      port,
      web: process.env.KESTREL_WEB ?? join(resources, "web"),
    }),
    DesktopDocs.layer(join(resources, "docs")),
  ),
);

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

const statusLine = (status: Status): string => {
  switch (status.state) {
    case "starting":
      return "Starting…";
    case "down":
      return "Server stopped, starting again…";
    case "up":
      return [
        "Running",
        `${status.connected} of ${plural(status.sources, "source")} connected`,
        ...(status.recording > 0
          ? [`recording ${plural(status.recording, "camera")}`]
          : []),
      ].join(" · ");
  }
};

const trayItems = (status: Status): TrayItem[] => [
  { type: "normal", label: statusLine(status), enabled: false },
  { type: "normal", label: "Docs", action: "docs" },
];

const docsUrl = () => runtime.runPromise(DesktopDocs.useSync(({ url }) => url));

const desktop = await openDesktopWindow(Electrobun, {
  title: "Kestrel",
  url: `${origin}/`,
  frame: { width: 1280, height: 800 },
  config: { ...config, ownOrigins: [origin] },
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
  },
  trayItems: trayItems({ state: "starting" }),
  // The docs built into the app, in the system browser
  onTrayAction: (action) => {
    if (action !== "docs") return;

    void docsUrl().then((url) => Electrobun.Utils.openExternal(url));
  },
  createRPC: (requests: DesktopRequests) =>
    BrowserView.defineRPC<DesktopSchema<AppRequests>>({
      maxRequestTime: 10_000,
      handlers: { requests: { ...requests, docs: docsUrl } },
    }),
});

runtime.runFork(
  Effect.gen(function* () {
    const { status } = yield* DesktopServer;

    yield* SubscriptionRef.changes(status).pipe(
      Stream.runForEach((next) =>
        Effect.sync(() => desktop.setTrayItems(trayItems(next))),
      ),
    );
  }),
);

// Stop the server, and go2rtc with it, before the app quits: the first quit
// waits for that, then quits again
let stopped = false;

Electrobun.events.on("before-quit", (event) => {
  if (stopped) return;
  event.response = { allow: false };
  void runtime.dispose().finally(() => {
    stopped = true;
    Electrobun.Utils.quit(0);
  });
});
