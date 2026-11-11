/**
 * The service worker, bundled to `sw.js`: keeps the app shell so the app
 * starts offline, and shows the server's pushes as notifications. The build
 * sets `GROUNDWORK_PWA_VERSION`, so each build replaces the last one's cache.
 */
import {
  servePush,
  serveShell,
  type PushWorkerScope,
  type ShellWorkerScope,
} from "@timmo001/groundwork-pwa/worker";
import config from "../pwa.config.ts";

declare const self: ShellWorkerScope & PushWorkerScope;

serveShell(self, config, {
  version: process.env.GROUNDWORK_PWA_VERSION ?? "dev",
});

servePush(self, config);
