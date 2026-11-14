/**
 * A camera's picture settings on the Live page: hue, brightness, contrast,
 * saturation and sharpness as sliders in a panel opened beside Move, with
 * Reset to put them back to the camera's defaults. A drag sends where it's
 * got to a few times a second, the newest replacing any change still
 * waiting, and the sliders then show what the camera says it's set to,
 * other than one being held. The panel follows the picked camera.
 */
import {
  cameraParts,
  PictureCommand,
  type CameraId,
  type PictureControls,
  type PictureState,
} from "@timmo001/kestrel-core";
import { call } from "./api.ts";
import { cameraLabel } from "./cameras.ts";
import { appliesAtOnce, element } from "./shared.ts";

/** How often a drag sends where it's got to, at most. */
const sendEvery = 250;

const settings = [
  ["hue", "Hue"],
  ["brightness", "Brightness"],
  ["contrast", "Contrast"],
  ["saturation", "Saturation"],
  ["sharpness", "Sharpness"],
] as const;

type Setting = (typeof settings)[number][0];

/** The picked camera, for one with picture settings. */
export interface PictureTile {
  readonly id: CameraId;
  readonly controls: PictureControls;
}

export interface PictureOptions {
  /** The button that opens the panel, which it opens beside. */
  readonly button: HTMLElementTagNameMap["gw-button"] | null;
  /** The picked camera, for one with picture settings. */
  readonly picked: () => PictureTile | undefined;
  /** The panel opened or closed, for the page's controls. */
  readonly onChange: () => void;
}

export interface PicturePanel {
  /** Whether the panel is open. */
  readonly open: () => boolean;
  /** Opens the panel for the picked camera, or closes it. */
  readonly toggle: () => void;
  /** Follows the picked camera, closing once it has no picture settings. */
  readonly show: () => void;
  readonly close: () => void;
}

/** Wires the picture settings panel to its button on the Live page. */
export const pictureSettings = (options: PictureOptions): PicturePanel => {
  const { button } = options;
  const panel = element("gw-popover");
  const body = element("gw-stack");
  const reset = element("gw-button", "Reset");
  const message = element("p");

  panel.classList.add("picture-panel");
  appliesAtOnce(panel);
  // Kept beside its button on a phone too, so the picture stays in sight
  panel.sheetBelow = 0;
  reset.setAttribute("size", "small");
  reset.setAttribute("label", "Put them back to the camera's defaults");
  message.className = "picture-note";

  const sliders = new Map(
    settings.map(([setting, label]) => {
      const slider = element("gw-range");

      slider.label = label;
      slider.unit = "%";
      slider.readout = true;

      return [setting, slider] as const;
    }),
  );

  body.setAttribute("gap", "s");
  body.append(...sliders.values(), message);
  reset.slot = "actions";
  panel.append(body, reset);
  document.body.append(panel);

  /** The camera the panel is for, and what it last said it's set to. */
  let current:
    { tile: PictureTile; state: PictureState | undefined } | undefined;

  let open = false;

  /** Changes made on the sliders that haven't gone yet, as shares. */
  let waiting: Partial<Record<Setting, number>> = {};
  let sending = false;
  let sentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const note = (text: string) => {
    message.textContent = text;
  };

  /** Puts what the camera said on the sliders, other than one being held or waiting to go. */
  const fill = () => {
    if (current === undefined) return;

    const { tile, state } = current;

    panel.heading = cameraLabel(tile.id);
    reset.hidden = !tile.controls.reset;
    reset.disabled = state === undefined;

    for (const [setting, slider] of sliders) {
      const share = state?.[setting] ?? null;

      slider.hidden =
        !tile.controls[setting] || (state !== undefined && share === null);
      slider.disabled = state === undefined;

      if (
        share !== null &&
        waiting[setting] === undefined &&
        !slider.matches(":active")
      ) {
        slider.value = Math.round(share * 100);
      }
    }
  };

  /** Takes what the camera said, where it's still the one shown. */
  const took = (
    id: CameraId,
    state: PictureState | undefined,
    failed: string,
  ) => {
    if (current?.tile.id !== id) return;

    if (state === undefined) {
      note(failed);

      return;
    }

    current.state = state;
    fill();
  };

  const refresh = async () => {
    if (current === undefined) return;

    const { id } = current.tile;

    const state = await call((api) =>
      api.cameras.picture({ params: cameraParts(id) }),
    ).catch(() => undefined);

    took(id, state, "Couldn't reach the camera");
  };

  const send = async () => {
    timer = undefined;

    if (current === undefined || sending) return;

    const change = waiting;

    waiting = {};

    if (Object.keys(change).length === 0) return;

    const { id } = current.tile;

    sending = true;
    sentAt = Date.now();
    note("");

    const state = await call((api) =>
      api.cameras.adjust({
        params: cameraParts(id),
        payload: PictureCommand.cases.Set.make(change),
      }),
    ).catch(() => undefined);

    sending = false;
    took(id, state, "Couldn't change the picture");
    later();
  };

  /** Sends what's waiting once it's been long enough since the last. */
  function later() {
    if (timer !== undefined || sending || Object.keys(waiting).length === 0) {
      return;
    }

    timer = setTimeout(
      () => void send(),
      Math.max(0, sentAt + sendEvery - Date.now()),
    );
  }

  for (const [setting, slider] of sliders) {
    slider.addEventListener("input", () => {
      waiting = { ...waiting, [setting]: slider.value / 100 };
      later();
    });
  }

  reset.addEventListener("click", async () => {
    if (current === undefined) return;

    const { id } = current.tile;

    clearTimeout(timer);
    timer = undefined;
    waiting = {};
    reset.disabled = true;
    note("");

    const state = await call((api) =>
      api.cameras.adjust({
        params: cameraParts(id),
        payload: PictureCommand.cases.Reset.make({}),
      }),
    ).catch(() => undefined);

    took(id, state, "Couldn't put the picture back");
    fill();
  });

  /** Forgets the camera, dropping any change still waiting. */
  const forget = () => {
    clearTimeout(timer);
    timer = undefined;
    waiting = {};
    current = undefined;
  };

  panel.addEventListener("close", () => {
    open = false;
    options.onChange();
  });

  const close = () => panel.close();

  const show = () => {
    const tile = options.picked();

    if (tile?.id === current?.tile.id) {
      if (tile !== undefined && current !== undefined) current.tile = tile;

      return;
    }

    forget();

    if (tile === undefined) {
      close();

      return;
    }

    current = { tile, state: undefined };
    note("");
    fill();

    if (open) void refresh();
  };

  // Whether it was open as its button was pressed, before that press shut
  // it, so the click doesn't open it again
  let openOnPress = false;

  window.addEventListener(
    "pointerdown",
    (event) => {
      openOnPress =
        open && button !== null && event.composedPath().includes(button);
    },
    true,
  );

  const toggle = () => {
    if (open) {
      close();

      return;
    }

    show();

    if (current === undefined) return;

    open = true;
    note("");
    fill();
    panel.show(button ?? undefined);
    options.onChange();
    void refresh();
  };

  button?.addEventListener("click", () => {
    if (openOnPress) {
      openOnPress = false;

      return;
    }

    toggle();
  });

  return { open: () => open, toggle, show, close };
};
