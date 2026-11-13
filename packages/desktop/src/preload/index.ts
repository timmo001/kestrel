/**
 * Runs in Kestrel's page before its own scripts: connects it to the main
 * process for Groundwork's desktop defaults, such as find in page, the zoom
 * and reload keys and the right-click menu.
 */
import {
  connectDesktop,
  type DesktopSchema,
} from "@timmo001/groundwork-desktop/view";
import { Electroview } from "electrobun/view";

// The page asks the main process for nothing beyond the desktop defaults
type NoRequests = Record<never, never>;

const connect = () =>
  connectDesktop<NoRequests>((messages) => {
    const rpc = Electroview.defineRPC<DesktopSchema<NoRequests>>({
      maxRequestTime: 10_000,
      handlers: { messages },
    });

    new Electroview({ rpc });

    return rpc;
  });

// The defaults add to the page's body, which isn't there yet
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void connect());
} else {
  void connect();
}
