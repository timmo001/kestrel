/**
 * The app's desktop config: Groundwork's browser defaults, running in the
 * tray with a start at login item. Kestrel's page has its own theme picker,
 * so the desktop's Omarchy theme stays off. The tray's title names it on
 * Linux, where the bar would otherwise show the process, `bun`.
 */
import { defineDesktopConfig } from "@timmo001/groundwork-desktop";

export default defineDesktopConfig({
  tray: { title: "Kestrel" },
  runInTray: true,
  startAtLogin: true,
  omarchyTheme: false,
  labels: { show: "Open Kestrel" },
});
