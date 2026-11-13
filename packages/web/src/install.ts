/**
 * The offer to install Kestrel as an app, where the browser can: a banner
 * until it's turned down once, either with Not now or in the browser's own
 * prompt, and an Install button in Settings for as long as the browser can,
 * which is the only place left to install from once the banner's dismissed.
 */
import type { Pwa } from "@timmo001/groundwork-pwa/view";
import { phDownloadSimple } from "./icons.ts";
import { find } from "./shared.ts";

const dismissedKey = "kestrel:install-dismissed";

export interface InstallOffer {
  /** Keeps the banner back while `held`, such as on the Pair page. */
  readonly hold: (held: boolean) => void;
}

export const installOffer = (pwa: Pwa): InstallOffer => {
  const banner = find("gw-banner", "install");
  const accept = find("gw-button", "install-accept");
  const dismiss = find("gw-button", "install-dismiss");
  const settings = find("gw-card", "settings-install");
  const settingsButton = find("gw-button", "settings-install-button");
  let held = false;

  const show = () => {
    const canInstall = pwa.canInstall();

    if (banner !== null) {
      banner.open =
        canInstall && !held && localStorage.getItem(dismissedKey) === null;
    }

    if (settings !== null) settings.hidden = !canInstall;
  };

  const turnDown = () => {
    localStorage.setItem(dismissedKey, new Date().toISOString());
    show();
  };

  const install = async () => {
    if ((await pwa.install()) === "dismissed") turnDown();
  };

  for (const button of [accept, settingsButton]) {
    button?.setAttribute("icon", phDownloadSimple);
    button?.addEventListener("click", () => void install());
  }

  dismiss?.addEventListener("click", turnDown);

  // The browser offers an install prompt, takes it back once it's used, and
  // sometimes offers another later
  window.addEventListener("gw-install-change", show);

  show();

  return {
    hold: (next) => {
      held = next;
      show();
    },
  };
};
