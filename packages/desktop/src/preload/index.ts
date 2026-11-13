/**
 * Runs in Kestrel's page before its own scripts: connects it to the main
 * process for Groundwork's desktop defaults, such as find in page, the zoom
 * and reload keys and the right-click menu, and points the page's docs link
 * at the docs built into the app.
 */
import {
  connectDesktop,
  type DesktopSchema,
} from "@timmo001/groundwork-desktop/view";
import { Electroview } from "electrobun/view";

import type { AppRequests } from "../requests.ts";

const connect = async () => {
  const { request } = await connectDesktop<AppRequests>((messages) => {
    const rpc = Electroview.defineRPC<DesktopSchema<AppRequests>>({
      maxRequestTime: 10_000,
      handlers: { messages },
    });

    new Electroview({ rpc });

    return rpc;
  });

  // The page opens this in place of the hosted docs, so they read offline
  document.documentElement.dataset.docs = await request.docs();
};

// The defaults add to the page's body, which isn't there yet
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void connect());
} else {
  void connect();
}
