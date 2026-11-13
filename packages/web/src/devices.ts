/**
 * The Devices panel in Settings: the devices paired with the server, each
 * with a Remove button, and Pair a device, which shows a one-time code and,
 * where other devices can reach the server, the pairing link as a QR code
 * for a phone's camera or the Android app.
 */
import type { Device } from "@timmo001/kestrel-server/api";
import { renderSVG } from "uqr";
import { call } from "./api.ts";
import { phPlus, phTrash } from "./icons.ts";
import { dateTimeFormat, element, find } from "./shared.ts";

export interface DevicesPanel {
  /** Loads the paired devices and shows them. */
  readonly start: () => Promise<void>;
}

const kindNames: Record<Device["kind"], string> = {
  browser: "Browser",
  desktop: "Desktop app",
  cli: "Command line",
  android: "Android app",
};

const when = (time: string | undefined) =>
  time === undefined ? "Not yet" : dateTimeFormat.format(new Date(time));

export const devicesPanel = (): DevicesPanel => {
  const table = find("gw-table", "devices-list");
  const pairButton = find("gw-button", "devices-pair");
  const codeAlert = find("gw-alert", "devices-code");
  const qr = find("div", "devices-qr");
  let hideCode: ReturnType<typeof setTimeout> | undefined;

  const load = async () => {
    const devices = await call((api) => api.devices.list()).catch(() => []);

    if (table === null) return;

    table.rows = devices.map((device) => ({
      key: device.id,
      id: device.id,
      name: device.name,
      kind: kindNames[device.kind],
      pairedAt: when(device.pairedAt),
      lastSeen: when(device.lastSeen),
    }));
  };

  if (table !== null) {
    table.emptyLabel = "No devices are paired yet.";
    table.columns = [
      { id: "name", header: "Device", wide: true },
      { id: "kind", header: "Kind" },
      { id: "pairedAt", header: "Paired", sortable: false },
      { id: "lastSeen", header: "Last used", sortable: false },
      {
        id: "remove",
        header: "",
        sortable: false,
        cell: (row) => {
          const remove = element("gw-button", "Remove");

          remove.setAttribute("icon", phTrash);
          remove.setAttribute("size", "small");
          remove.setAttribute("appearance", "plain");
          remove.setAttribute("variant", "danger");
          remove.setAttribute("labels", "hide");
          remove.addEventListener("click", () => {
            void call((api) =>
              api.devices.revoke({ params: { id: String(row.id) } }),
            ).then(load, load);
          });

          return remove;
        },
      },
    ];
  }

  pairButton?.setAttribute("icon", phPlus);

  pairButton?.addEventListener("click", () => {
    void call((api) => api.devices.code()).then((pairing) => {
      if (codeAlert === null || qr === null) return;

      codeAlert.setAttribute("tone", "info");
      codeAlert.textContent =
        pairing.link === undefined
          ? `Pairing code ${pairing.code}. It works once, for 5 minutes. Other devices can't reach this server yet, so type it on a browser that can.`
          : `Pairing code ${pairing.code}. It works once, for 5 minutes: type it on the device, or scan the code with its camera.`;
      codeAlert.hidden = false;

      // Black on white, as a phone's camera reads best
      qr.innerHTML =
        pairing.link === undefined
          ? ""
          : renderSVG(pairing.link, { whiteColor: "#fff", blackColor: "#000" });
      qr.hidden = pairing.link === undefined;

      clearTimeout(hideCode);
      hideCode = setTimeout(
        () => {
          codeAlert.hidden = true;
          qr.hidden = true;
          void load();
        },
        Date.parse(pairing.expires) - Date.now(),
      );
    });
  });

  return { start: load };
};
