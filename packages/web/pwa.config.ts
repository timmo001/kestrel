/**
 * The app's PWA config: what `@timmo001/groundwork-pwa` gives it. The build
 * writes the manifest from it, and the page and service worker read it.
 */
import { definePwaConfig } from "@timmo001/groundwork-pwa";

export default definePwaConfig({
  name: "Kestrel",
  shortName: "Kestrel",
  description: "Your cameras and recorders: live view, recordings and events",
  shortcuts: [
    { name: "Recordings", url: "./recordings" },
    { name: "Events", url: "./events" },
    { name: "Sources", url: "./sources" },
  ],
  // Kestrel has nothing to do with a share, so it stays out of the share sheet
  shareTarget: false,
  offline: {
    // The page's own files too, so the app starts offline after its first
    // visit, before the worker has seen them fetched
    shell: [
      "./",
      "index.js",
      "index.css",
      "manifest.webmanifest",
      "icons/icon-192.png",
      "icons/icon-512.png",
      "icons/maskable-512.png",
    ],
  },
  manifest: {
    categories: ["security", "utilities"],
    // A shortcut or a notification's link opens in the app's window if it's
    // already open, rather than in another
    launch_handler: { client_mode: "navigate-existing" },
  },
});
