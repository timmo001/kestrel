/**
 * The Devices panel in Settings: the devices paired with the server, each
 * with a Remove button, and Pair a device, which opens Groundwork's pairing
 * screen by the button: a one-time code to copy, its countdown, and where
 * other devices can reach the server, the pairing link as a QR code for a
 * phone's camera or the Android app.
 */
import type { Device } from "@timmo001/kestrel-server/api";
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
  const popover = find("gw-popover", "devices-pairing");
  const pairing = popover?.querySelector("gw-pairing") ?? null;

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
    // Followed by id, so a device paired or removed slides the rest
    table.setAttribute("row-key", "key");
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

  if (pairing !== null) {
    // Without a link, other devices can't reach this server yet, so the
    // code is typed on a browser that can, and Copy copies the code
    const make = async () => {
      const made = await call((api) => api.devices.code());

      pairing.instructionsLabel =
        made.link === undefined
          ? "Other devices can't reach this server yet: type the code on a browser that can."
          : "Scan this with the other device's camera, or open Kestrel there and type the code.";

      return made.link === undefined
        ? { code: made.code, expires: made.expires }
        : { code: made.code, expires: made.expires, link: made.link };
    };

    // A new code each time it opens: the first as `make` is given, which
    // waits for the first press so no code is made unasked; the list again
    // once it closes, in case the code paired a device
    pairButton?.addEventListener("click", () => {
      if (popover === null) return;

      if (popover.open) {
        popover.close();

        return;
      }

      popover.show(pairButton);

      if (pairing.make === undefined) pairing.make = make;
      else void pairing.refresh();
    });

    popover?.addEventListener("close", () => void load());
  }

  return { start: load };
};
