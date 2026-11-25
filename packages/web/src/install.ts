/**
 * The offer to install Kestrel as an app, where the browser can: Groundwork's
 * install banner until it's turned down once, and an Install button in
 * Settings for as long as the browser can, which is the only place left to
 * install from once the banner's dismissed.
 */
import type { Pwa } from "@timmo001/groundwork-pwa/view";
import { phDownloadSimple } from "./icons.ts";
import { find } from "./shared.ts";

export interface InstallOffer {
  /** Keeps the banner back while `held`, such as on the Pair page. */
  readonly hold: (held: boolean) => void;
}

export const installOffer = (pwa: Pwa): InstallOffer => {
  const banner = find("gw-install-banner", "install");
  const settings = find("gw-card", "settings-install");
  const settingsButton = find("gw-button", "settings-install-button");

  if (banner !== null) banner.pwa = pwa;

  const show = () => {
    if (settings !== null) settings.hidden = !pwa.canInstall();
  };

  settingsButton?.setAttribute("icon", phDownloadSimple);
  // Through the banner, so turning the browser's prompt down here keeps the
  // banner down too
  settingsButton?.addEventListener(
    "click",
    () => void (banner?.install() ?? pwa.install()),
  );

  window.addEventListener("gw-install-change", show);

  show();

  return {
    hold: (held) => {
      if (banner !== null) banner.held = held;
    },
  };
};
