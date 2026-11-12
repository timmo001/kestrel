/**
 * The app's PWA config: what `@timmo001/groundwork-pwa` gives it. The build
 * writes the manifest from it, and the page and service worker read it.
 */
import { definePwaConfig } from "@timmo001/groundwork-pwa";

export default definePwaConfig({
  name: "Kestrel",
  shortName: "DVR",
  description: "Recorder health, recordings and events from your DVR",
  shortcuts: [
    { name: "Recordings", url: "./recordings" },
    { name: "Events", url: "./events" },
    { name: "Recorder", url: "./recorder" },
  ],
});
