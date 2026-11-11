/**
 * The service worker, bundled to `sw.js`: keeps the app shell so the app
 * starts offline. The build sets `GROUNDWORK_PWA_VERSION`, so each build
 * replaces the last one's cache.
 */
import {
  serveShell,
  type ShellWorkerScope,
} from "@timmo001/groundwork-pwa/worker";
import config from "../pwa.config.ts";

declare const self: ShellWorkerScope;

serveShell(self, config, {
  version: process.env.GROUNDWORK_PWA_VERSION ?? "dev",
});
