/**
 * The app's desktop config: Groundwork's browser defaults, running in the
 * tray with a start at login item. Kestrel's page has its own theme picker,
 * so the desktop's Omarchy theme stays off.
 */
import { defineDesktopConfig } from "@timmo001/groundwork-desktop";

export default defineDesktopConfig({
  runInTray: true,
  startAtLogin: true,
  omarchyTheme: false,
  labels: { show: "Open Kestrel" },
});
