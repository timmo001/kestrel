/**
 * The service worker, bundled to `sw.js`: keeps the app shell so the app
 * starts offline, and shows the server's pushes as notifications. The build
 * sets `GROUNDWORK_PWA_VERSION`, so each build's worker differs from the
 * last, replaces it and its cache, and takes over open pages by itself.
 */
import {
  networkFirst,
  servePush,
  serveShell,
  type PushWorkerScope,
  type ShellWorkerScope,
} from "@timmo001/groundwork-pwa/worker";
import config from "../pwa.config.ts";

declare const self: ShellWorkerScope & PushWorkerScope;

const resolve = (path: string) => new URL(path, self.location.href).href;

// The server's own routes are live, so they always go to the network rather
// than being answered from the cache
const live = ["api/", "go2rtc/", "push/"].map(resolve);

// The page's script and styles come from the network first, like the page,
// so a page from a new release never starts with the last one's bundle. The
// cached copies only start the app offline
const bundle = ["index.js", "index.css"].map(resolve);

serveShell(self, config, {
  version: process.env.GROUNDWORK_PWA_VERSION ?? "dev",
  routes: [
    ({ request }) =>
      live.some((prefix) => request.url.startsWith(prefix))
        ? fetch(request)
        : undefined,
    ({ request }, cache) =>
      request.method === "GET" && bundle.includes(request.url)
        ? networkFirst(cache, request)
        : undefined,
  ],
});

servePush(self, config);
