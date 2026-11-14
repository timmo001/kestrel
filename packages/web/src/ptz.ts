/**
 * A camera that moves, on the Live page. The picked one has a Move button
 * on its picture, and Move mode brings in its panel, off the picture: the
 * arrow pad and lens zoom, Home, its presets, and a gear that opens a panel
 * that saves, renames and clears presets and sets how it goes home and
 * follows what it sees. Out of Move mode its picture is like any other's.
 * In Move mode it turns while a drag on its
 * picture or an arrow on its pad is held, faster the further it's dragged,
 * and stops when it's let go; the arrow keys do the same while they're
 * held. Ctrl and the wheel, a pinch, the + and − keys or the slider under
 * the pad zoom its lens where the picture shown is the one it zooms. The
 * server stops a camera that isn't told to keep moving, so the page says so
 * again while it's held, and a page that closes mid-drag doesn't leave the
 * camera turning.
 */
import {
  cameraParts,
  PtzCommand,
  type CameraId,
  type PtzControls,
  type PtzState,
  type TrackMethod,
  type TrackTarget,
} from "@timmo001/kestrel-core";
import { call } from "./api.ts";
import { cameraLabel } from "./cameras.ts";
import {
  phCaretDownBold,
  phCaretLeftBold,
  phCaretRightBold,
  phCaretUpBold,
  phGearBold,
  phHouseBold,
  phJoystick,
  phMagnifyingGlassMinusBold,
  phMagnifyingGlassPlusBold,
  phPlus,
  phTrash,
} from "./icons.ts";
import { element, settingsSheet } from "./shared.ts";

/** How often a drag sends where it's steering, at most. */
const sendEvery = 200;

/** How often a held drag says again to keep moving, inside the server's second. */
const keepEvery = 500;

/** How near the middle of a drag counts as still, as a share of full speed. */
const deadZone = 0.06;

/** How far a drag goes for full speed, as a share of the tile. */
const fullReach = 0.4;

/** How fast the arrow keys turn a camera, as a share of full speed. */
const keySpeed = 0.5;

/** How far each step of the lens zoom goes, as a share of its range. */
const zoomStep = 0.1;

/** The narrowest picture Move says its name on, in pixels. */
const wordyTile = 300;

/**
 * How often the picked camera's state is read again, since it moves by
 * itself too, such as going home or following what it sees. It waits as
 * long after the page last told it something, so a zoom on its way isn't
 * shown going back.
 */
const readEvery = 3000;

/** How much of the wheel or a pinch makes a step, as the picture zoom has it. */
const wheelStep = 50;

/** The waits before going home on offer, in seconds, beside the camera's own. */
const homeChoices = [10, 30, 60, 120, 180, 300];

/** A move or a stop, which a newer one replaces before it's sent. */
const moving = PtzCommand.isAnyOf(["Move", "Stop"]);

const zooming = PtzCommand.isAnyOf(["Zoom"]);

/** The arrow pad's buttons, by the key each stands for. */
const arrows = [
  ["ArrowUp", phCaretUpBold, "Up"],
  ["ArrowLeft", phCaretLeftBold, "Left"],
  ["ArrowRight", phCaretRightBold, "Right"],
  ["ArrowDown", phCaretDownBold, "Down"],
] as const;

type Arrow = (typeof arrows)[number][0];

/** What tracking follows, as the page names them. */
const targetNames: Record<TrackTarget, string> = {
  people: "People",
  vehicles: "Vehicles",
  animals: "Animals",
};

const methodNames: Record<TrackMethod, string> = {
  digital: "Zoom the picture only",
  "digital-first": "Zoom the picture, then turn",
  "turn-first": "Turn first",
};

/** What the page says when the camera doesn't take a command. */
const failures: Record<PtzCommand["_tag"], string> = {
  Move: "Couldn't reach the camera",
  Stop: "Couldn't reach the camera",
  Zoom: "Couldn't zoom the lens",
  Preset: "Couldn't go to the preset",
  SavePreset: "Couldn't save the preset",
  RenamePreset: "Couldn't rename the preset",
  ClearPreset: "Couldn't clear the preset",
  Home: "Couldn't send it home",
  SetHome: "Couldn't set its home",
  Track: "Couldn't change tracking",
  KeepHome: "Couldn't change going home",
};

/** A wait in seconds, such as "30 s" or "2 min". */
const wait = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;

/** The picked camera's tile, as steering sees it. */
export interface SteerTile {
  readonly id: CameraId;
  readonly figure: HTMLElement;
  readonly controls: PtzControls;
  /** Whether its lens zoom changes the picture shown, such as a TrackMix's telephoto. */
  readonly lensZoom: boolean;
}

export interface SteeringOptions {
  /** The tiles' grid, where the wheel and drags are caught. */
  readonly area: HTMLElement | null;
  /** Where the camera's controls go, off its picture. */
  readonly host: HTMLElement | null;
  /** What they go before in `host`, such as the page's controls. */
  readonly before: Element | null;
  /** The picked camera's tile, for a camera that moves. */
  readonly picked: () => SteerTile | undefined;
  /** Move mode started or ended, for the page's controls. */
  readonly onChange: () => void;
  /**
   * Move or Done pressed, for the page to call `toggle` with what goes with
   * it, such as going to the camera alone, as one transition.
   */
  readonly onToggle: () => void;
}

export interface Steering {
  /** Whether Move mode is on. */
  readonly on: () => boolean;
  /** Starts Move mode on the picked camera, or ends it. */
  readonly toggle: () => void;
  /** Ends Move mode, stopping the camera. */
  readonly leave: () => void;
  /**
   * Puts the controls on the picked tile, ending Move mode once it's
   * another camera.
   */
  readonly show: () => void;
  /** Whether a gesture on a tile steers rather than moving its picture. */
  readonly steers: (figure: HTMLElement, gesture: "drag" | "wheel") => boolean;
  /** An arrow key pressed or let go. */
  readonly key: (key: Arrow, down: boolean) => void;
  /** Zooms the lens a step, or says it can't, so the picture zooms instead. */
  readonly zoomStep: (by: -1 | 1) => boolean;
}

/** A drag's offset on one axis as a speed, still near the middle. */
const speedOf = (offset: number) => {
  const share = Math.min(1, Math.abs(offset) / fullReach);

  if (share < deadZone) return 0;

  // Slow near the middle, for small moves on a long lens
  return Math.sign(offset) * ((share - deadZone) / (1 - deadZone)) ** 1.5;
};

/**
 * A button for the panel, small, or for the tile's controls, as big as the
 * page's own; one with an icon shows only the icon.
 */
const controlButton = (
  label: string,
  icon?: string,
  size: "small" | "medium" | "large" = "small",
) => {
  const button = element("gw-button", label);

  button.setAttribute("label", label);
  button.setAttribute("size", size);

  if (icon !== undefined) {
    button.setAttribute("icon", icon);
    button.setAttribute("labels", "hide");
    button.setAttribute("appearance", "plain");
  }

  return button;
};

/** A button on the tile's controls, as big as the page's own. */
const tileButton = (label: string, icon?: string) =>
  controlButton(label, icon, "medium");

/** How many of each button's presses the camera has still to answer. */
const waiting = new WeakMap<HTMLElement, number>();

/**
 * Marks a press as waiting on the camera until it answers. Unlike `loading`,
 * the button still takes another press, such as a second step of zoom.
 */
const pending = (button: HTMLElement, answered: Promise<unknown>) => {
  waiting.set(button, (waiting.get(button) ?? 0) + 1);
  button.toggleAttribute("data-pending", true);

  void answered.finally(() => {
    const left = (waiting.get(button) ?? 1) - 1;

    waiting.set(button, left);
    button.toggleAttribute("data-pending", left > 0);
  });
};

/** Wires the controls of a camera that moves on the Live page's tiles. */
export const steering = (options: SteeringOptions): Steering => {
  const { area } = options;

  /** The picked camera, where it moves, and what it reported. */
  let current:
    { readonly tile: SteerTile; state: PtzState | undefined } | undefined;

  /** Whether Move mode is on, for the picked camera. */
  let on = false;

  /** Where it's being told to move, until it's let go. */
  let wanted: { pan: number; tilt: number } | undefined;
  let sent: { pan: number; tilt: number; at: number } | undefined;
  let ticking: ReturnType<typeof setInterval> | undefined;

  // Commands go one at a time, so a Stop never overtakes the Move before it.
  // A move waiting to go is replaced by a newer one
  const queue: Array<{
    id: CameraId;
    command: PtzCommand;
    done: (taken: boolean) => void;
  }> = [];

  let sending = false;

  /** When the page last told the camera something, for `readEvery`. */
  let told = 0;

  const flush = async () => {
    if (sending) return;

    sending = true;

    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const { id, command } = next;

      const taken = await call((api) =>
        api.cameras.steer({ params: cameraParts(id), payload: command }),
      ).then(
        () => true,
        () => false,
      );

      if (!taken) note(failures[command._tag]);

      next.done(taken);
    }

    sending = false;
  };

  /** Sends a command to the picked camera, resolving with whether it took it. */
  const send = (command: PtzCommand) =>
    new Promise<boolean>((resolve) => {
      if (current === undefined) {
        resolve(false);

        return;
      }

      const last = queue.at(-1);

      if (
        last !== undefined &&
        ((moving(last.command) && moving(command)) ||
          (zooming(last.command) && zooming(command)))
      ) {
        queue.pop()?.done(true);
      }

      queue.push({ id: current.tile.id, command, done: resolve });
      told = Date.now();
      void flush();
    });

  /** Sends where it's steering when that's changed, or again to keep it going. */
  const tick = () => {
    if (wanted === undefined) return;

    const since = sent === undefined ? Infinity : Date.now() - sent.at;

    const changed =
      sent === undefined ||
      sent.pan !== wanted.pan ||
      sent.tilt !== wanted.tilt;

    if ((changed && since >= sendEvery) || since >= keepEvery) {
      sent = { ...wanted, at: Date.now() };
      void send(PtzCommand.cases.Move.make(wanted));
    }
  };

  const aim = (pan: number, tilt: number) => {
    const { controls } = current?.tile ?? {};

    wanted = {
      pan: controls?.pan === true ? pan : 0,
      tilt: controls?.tilt === true ? tilt : 0,
    };
    ticking ??= setInterval(tick, sendEvery / 2);
    tick();
  };

  /** Stops the camera, if it was told to move. */
  const halt = () => {
    clearInterval(ticking);
    ticking = undefined;
    wanted = undefined;
    drag = undefined;
    held.clear();
    showDrag();

    if (sent !== undefined) {
      sent = undefined;
      void send(PtzCommand.cases.Stop.make({}));
    }
  };

  /**
   * The picked camera's controls, in a panel of their own beside the page's
   * controls rather than over its picture, there only in Move mode: a titled
   * bar saying so with Done, over the arrow pad and the lens zoom, then Home,
   * the presets and the gear. Move, on the picture, starts it. The drag's
   * line goes on the picture.
   */
  const dock = element("div");
  const moveButton = tileButton("Move the camera (M)", phJoystick);
  const head = element("div");
  const title = element("span");
  const hint = element("span", "Drag the picture, or hold an arrow");
  const done = tileButton("Done");
  const body = element("div");
  const pad = element("div");
  const arrowPad = element("div");
  const zoomRow = element("div");
  const zoomOut = tileButton("Zoom out (−)", phMagnifyingGlassMinusBold);
  const zoomSlider = element("gw-range");
  const zoomIn = tileButton("Zoom in (+)", phMagnifyingGlassPlusBold);
  const bar = element("div");
  const presets = element("gw-row");
  const homeButton = tileButton("Send it home", phHouseBold);
  const split = element("span");
  const setupButton = tileButton("Presets, home and tracking", phGearBold);
  const message = element("span");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const stroke = document.createElementNS("http://www.w3.org/2000/svg", "line");

  dock.className = "live-steer-dock";
  moveButton.className = "live-steer-move";
  moveButton.setAttribute("aria-keyshortcuts", "m");
  moveButton.textContent = "Move";
  head.className = "live-steer-head";
  title.className = "live-steer-title";
  hint.className = "live-steer-hint";
  body.className = "live-steer-body";
  pad.className = "live-steer-pad";
  pad.setAttribute("role", "group");
  pad.setAttribute("aria-label", "Move the camera");
  arrowPad.className = "live-arrow-pad";
  zoomRow.className = "live-zoom-row";
  zoomSlider.label = "Lens zoom";
  zoomSlider.labelHidden = true;
  zoomSlider.unit = "%";
  zoomSlider.readout = true;
  bar.className = "live-steer-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Camera controls");
  presets.className = "live-presets";
  // More presets than fit scroll sideways, with a ‹ or › while there's more
  presets.setAttribute("scroll", "");
  presets.setAttribute("justify", "center");
  homeButton.setAttribute("appearance", "accent");
  split.className = "live-steer-split";
  split.setAttribute("aria-hidden", "true");
  message.className = "live-steer-note";
  line.classList.add("live-steer-line");
  line.setAttribute("aria-hidden", "true");
  line.append(stroke);

  /** Each arrow's button, held to turn that way, as its key is. */
  const arrowButtons = arrows.map(([arrow, icon, label]) => {
    const button = controlButton(label, icon, "large");

    button.dataset["arrow"] = arrow;
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;

      button.setPointerCapture(event.pointerId);
      key(arrow, true);
    });

    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      button.addEventListener(type, () => key(arrow, false));
    }

    // Enter or Space on a focused arrow turns it a moment, as a tap does
    button.addEventListener("keydown", (event) => {
      if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return;

      event.preventDefault();
      event.stopPropagation();
      key(arrow, true);
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === "Enter" || event.key === " ") key(arrow, false);
    });

    return [arrow, button] as const;
  });

  arrowPad.append(...arrowButtons.map(([, button]) => button));
  zoomRow.append(zoomOut, zoomSlider, zoomIn);
  pad.append(arrowPad, zoomRow);
  // Home first, as the main way back, then the presets past a line
  bar.append(homeButton, split, presets, setupButton, message);
  head.append(title, hint, done);
  body.append(pad, bar);
  dock.append(head, body);
  done.setAttribute("variant", "brand");
  done.addEventListener("click", () => options.onToggle());

  // A press on Move is its own, not a tap or double tap on the picture
  moveButton.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onToggle();
  });

  for (const target of [dock, moveButton]) {
    target.addEventListener("dblclick", (event) => event.stopPropagation());
  }

  // On a small picture, Move is only its icon, so it covers little of it
  const sizing = new ResizeObserver(([entry]) => {
    moveButton.setAttribute(
      "labels",
      (entry?.contentRect.width ?? 0) < wordyTile ? "hide" : "show",
    );
  });

  /** The setup, opened from the gear: presets, home and tracking. */
  const panel = settingsSheet("ptz-panel");

  function note(text: string) {
    message.textContent = text;
  }

  const lensZoom = () =>
    on &&
    current !== undefined &&
    current.tile.controls.zoom &&
    current.tile.lensZoom &&
    current.state?.zoom !== null &&
    current.state?.zoom !== undefined;

  const showBar = () => {
    if (current === undefined) return;

    const { state } = current;
    const { controls } = current.tile;
    const zooms = lensZoom();

    // The panel's there only in Move mode, so the cameras have the room
    if (!on) dock.remove();
    else if (dock.parentElement !== options.host) {
      options.host?.insertBefore(dock, options.before);
    }

    moveButton.hidden = on;
    title.textContent = `Moving ${cameraLabel(current.tile.id)}`;
    zoomRow.hidden = !zooms;
    zoomSlider.value = Math.round((state?.zoom ?? 0) * 100);
    zoomOut.disabled = (state?.zoom ?? 0) <= 0;
    zoomIn.disabled = (state?.zoom ?? 0) >= 1;

    for (const [arrow, button] of arrowButtons) {
      button.hidden =
        arrow === "ArrowUp" || arrow === "ArrowDown"
          ? !controls.tilt
          : !controls.pan;
    }

    presets.replaceChildren(
      ...(state?.presets ?? []).map((preset) => {
        const button = tileButton(preset.name);

        // Quieter than Home: a preset is a choice, not the main action
        button.setAttribute("appearance", "filled");
        button.setAttribute("variant", "neutral");
        button.setAttribute("label", `Go to ${preset.name}`);
        button.addEventListener("click", () =>
          pending(
            button,
            send(PtzCommand.cases.Preset.make({ id: preset.id })),
          ),
        );

        return button;
      }),
    );

    homeButton.hidden = state?.home?.set !== true;
    split.hidden = homeButton.hidden || presets.childElementCount === 0;

    setupButton.hidden =
      state === undefined ||
      (!controls.presets && state.home === null && state.tracking === null);
  };

  /** Reads the camera's state again, for the bar and an open panel. */
  const refresh = async ({ quiet = false } = {}) => {
    if (current === undefined) return;

    const { id } = current.tile;

    const state = await call((api) =>
      api.cameras.ptz({ params: cameraParts(id) }),
    ).catch(() => undefined);

    if (current?.tile.id !== id) return;

    if (state === undefined) {
      if (!quiet) note("Couldn't reach the camera");

      return;
    }

    // Drawn again only when it's changed, so a focused preset keeps focus
    if (JSON.stringify(state) === JSON.stringify(current.state)) return;

    current.state = state;
    showBar();
  };

  /**
   * Reads it again now and then, while the page shows and nobody's steering
   * it or holding the slider.
   */
  const reading = () => {
    if (
      current === undefined ||
      document.visibilityState !== "visible" ||
      sending ||
      queue.length > 0 ||
      wanted !== undefined ||
      zoomSlider.matches(":active") ||
      Date.now() - told < readEvery
    ) {
      return;
    }

    void refresh({ quiet: true });
  };

  setInterval(reading, readEvery);

  /** Sends a change, then reads back what the camera has now. */
  const change = async (command: PtzCommand) => {
    note("");

    const taken = await send(command);

    await refresh();

    return taken;
  };

  homeButton.addEventListener("click", () =>
    pending(homeButton, send(PtzCommand.cases.Home.make({}))),
  );

  /** A labelled pick of numbers, such as how long before it goes home. */
  const secondsField = (
    label: string,
    value: number,
    choices: ReadonlyArray<number>,
    onPick: (seconds: number) => void,
  ) => {
    const field = element("gw-select");

    field.label = label;
    field.options = [...new Set([...choices, value])]
      .toSorted((a, b) => a - b)
      .map((seconds) => ({ value: String(seconds), label: wait(seconds) }));
    field.value = String(value);
    field.addEventListener("change", () => onPick(Number(field.value)));

    return field;
  };

  const fillPanel = () => {
    if (current === undefined || current.state === undefined) return;

    const { state, tile } = current;
    const sections: Array<HTMLElement> = [];

    panel.heading = cameraLabel(tile.id);

    if (tile.controls.presets) {
      const list = element("gw-stack");

      list.setAttribute("gap", "s");

      for (const preset of state.presets) {
        const row = element("gw-row");
        const name = element("gw-input");
        const clear = controlButton(`Clear ${preset.name}`, phTrash);

        row.setAttribute("nowrap", "");
        name.label = `Preset ${preset.id + 1}`;
        name.value = preset.name;
        name.setAttribute("maxlength", "32");
        name.setAttribute("size", "small");
        name.addEventListener("change", () => {
          const typed = name.value.trim();

          if (typed === "" || typed === preset.name) return;

          void change(
            PtzCommand.cases.RenamePreset.make({ id: preset.id, name: typed }),
          ).then(fillPanel);
        });
        clear.addEventListener(
          "click",
          () =>
            void change(
              PtzCommand.cases.ClearPreset.make({ id: preset.id }),
            ).then(fillPanel),
        );
        row.append(name, clear);
        list.append(row);
      }

      const saveRow = element("gw-row");
      const newName = element("gw-input");
      const save = controlButton("Save");

      saveRow.setAttribute("nowrap", "");
      saveRow.setAttribute("align", "end");
      newName.label = "Save where it points now";
      newName.placeholder = "Name";
      newName.setAttribute("maxlength", "32");
      newName.setAttribute("size", "small");
      save.setAttribute("icon", phPlus);

      const saveNew = () => {
        const typed = newName.value.trim();

        if (typed === "") return;

        void change(PtzCommand.cases.SavePreset.make({ name: typed })).then(
          fillPanel,
        );
      };

      save.addEventListener("click", saveNew);
      newName.addEventListener("keydown", (event) => {
        if (event.key === "Enter") saveNew();
      });
      saveRow.append(newName, save);
      list.append(saveRow);
      sections.push(heading("Presets"), list);
    }

    const { home } = state;

    if (home !== null) {
      const keep = element("gw-switch");
      const goHome = controlButton("Go home");
      const setHere = controlButton("Make here home");
      const buttons = element("gw-row");

      keep.label = "Go home when left alone";
      keep.checked = home.on;
      keep.addEventListener(
        "change",
        () => void change(PtzCommand.cases.KeepHome.make({ on: keep.checked })),
      );
      goHome.disabled = !home.set;
      goHome.addEventListener("click", () =>
        pending(goHome, send(PtzCommand.cases.Home.make({}))),
      );
      setHere.addEventListener("click", () =>
        pending(
          setHere,
          change(PtzCommand.cases.SetHome.make({})).then(fillPanel),
        ),
      );
      buttons.setAttribute("gap", "s");
      buttons.append(goHome, setHere);
      sections.push(
        heading("Home"),
        keep,
        secondsField(
          "After it's left alone for",
          home.backAfter,
          homeChoices,
          (backAfter) =>
            void change(PtzCommand.cases.KeepHome.make({ backAfter })),
        ),
        buttons,
      );
    }

    const { tracking } = state;

    if (tracking !== null) {
      const follow = element("gw-switch");
      const targets = element("gw-row");

      follow.label = "Follow what it sees";
      follow.checked = tracking.on;
      follow.addEventListener(
        "change",
        () => void change(PtzCommand.cases.Track.make({ on: follow.checked })),
      );
      targets.setAttribute("gap", "s");

      const boxes = tracking.targets.map((target) => {
        const box = element("gw-checkbox");

        box.label = targetNames[target];
        box.checked = tracking.follows.includes(target);

        return [target, box] as const;
      });

      for (const [, box] of boxes) {
        box.addEventListener(
          "change",
          () =>
            void change(
              PtzCommand.cases.Track.make({
                follows: boxes
                  .filter(([, each]) => each.checked)
                  .map(([target]) => target),
              }),
            ),
        );
        targets.append(box);
      }

      sections.push(heading("Tracking"), follow, targets);

      if (tracking.method !== null && tracking.methods.length > 1) {
        const method = element("gw-select");

        method.label = "How it follows";
        method.options = tracking.methods.map((each) => ({
          value: each,
          label: methodNames[each],
        }));
        method.value = tracking.method;
        method.addEventListener("change", () => {
          const picked = tracking.methods.find((each) => each === method.value);

          if (picked !== undefined) {
            void change(PtzCommand.cases.Track.make({ method: picked }));
          }
        });
        sections.push(method);
      }

      if (tracking.backAfterLeaving !== null) {
        sections.push(
          secondsField(
            "Goes home after its subject leaves for",
            tracking.backAfterLeaving,
            tracking.backChoices,
            (backAfterLeaving) =>
              void change(PtzCommand.cases.Track.make({ backAfterLeaving })),
          ),
        );
      }

      if (tracking.backAfterStopping !== null) {
        sections.push(
          secondsField(
            "Or stops for",
            tracking.backAfterStopping,
            tracking.backChoices,
            (backAfterStopping) =>
              void change(PtzCommand.cases.Track.make({ backAfterStopping })),
          ),
        );
      }
    }

    const body = element("gw-stack");

    body.append(...sections);
    panel.replaceChildren(body);
  };

  function heading(text: string) {
    const title = element("gw-section-title", text);

    title.setAttribute("level", "3");

    return title;
  }

  setupButton.addEventListener("click", () => {
    fillPanel();
    panel.show();
    void refresh().then(fillPanel);
  });

  const zoomTo = (level: number) => {
    if (current?.state === undefined || !lensZoom()) return;

    const next = Math.round(Math.min(1, Math.max(0, level)) * 100) / 100;

    current.state = {
      zoom: next,
      presets: current.state.presets,
      home: current.state.home,
      tracking: current.state.tracking,
    };
    void send(PtzCommand.cases.Zoom.make({ level: next }));
    showBar();
  };

  const stepZoom = (by: -1 | 1) => {
    if (!lensZoom()) return false;

    zoomTo((current?.state?.zoom ?? 0) + by * zoomStep);

    return true;
  };

  zoomSlider.addEventListener("input", () => zoomTo(zoomSlider.value / 100));
  zoomOut.addEventListener("click", () => stepZoom(-1));
  zoomIn.addEventListener("click", () => stepZoom(1));

  /** Shows whether Move mode is on, on the tile and the page. */
  const showMode = () => {
    current?.tile.figure.toggleAttribute("data-steering", on);
    showBar();
    options.onChange();
  };

  const leave = () => {
    if (!on) return;

    halt();
    on = false;
    showMode();
  };

  /** Takes the controls off the tile they were on. */
  const detach = () => {
    if (current === undefined) return;

    halt();
    current.tile.figure.removeAttribute("data-steering");
    dock.remove();
    line.remove();
    moveButton.remove();
    sizing.disconnect();
    panel.close();
    current = undefined;
  };

  const show = () => {
    const tile = options.picked();

    if (tile === undefined || tile.id !== current?.tile.id) {
      const wasOn = on;

      detach();
      on = false;

      if (wasOn) options.onChange();

      if (tile === undefined) return;

      current = { tile, state: undefined };
      note("");
      void refresh();
    }

    // The page draws its tiles again, such as after a layout change, so the
    // line moves to the camera's new one
    if (tile.figure !== current?.tile.figure) {
      halt();
      current?.tile.figure.removeAttribute("data-steering");
    }

    current = { tile, state: current?.state };
    tile.figure.toggleAttribute("data-steering", on);
    tile.figure.append(line, moveButton);
    sizing.disconnect();
    sizing.observe(tile.figure);
    showBar();
  };

  const toggle = () => {
    if (on) {
      leave();

      return;
    }

    show();

    if (current === undefined) return;

    on = true;
    note("");
    showMode();
    void refresh();
  };

  // A drag from where it's pressed steers that way, faster further out
  let drag: { x: number; y: number; to: { x: number; y: number } } | undefined;

  const showDrag = () => {
    line.toggleAttribute("data-shown", drag !== undefined);

    if (drag === undefined || current === undefined) return;

    const box = current.tile.figure.getBoundingClientRect();

    stroke.setAttribute("x1", String(drag.x - box.left));
    stroke.setAttribute("y1", String(drag.y - box.top));
    stroke.setAttribute("x2", String(drag.to.x - box.left));
    stroke.setAttribute("y2", String(drag.to.y - box.top));
  };

  area?.addEventListener("pointerdown", (event) => {
    if (
      !on ||
      current === undefined ||
      event.button !== 0 ||
      !event.composedPath().includes(current.tile.figure) ||
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element && target.matches(".live-inset"),
        )
    ) {
      return;
    }

    const point = { x: event.clientX, y: event.clientY };

    drag = { ...point, to: point };
    current.tile.figure.setPointerCapture(event.pointerId);
    showDrag();
  });

  window.addEventListener("pointermove", (event) => {
    if (drag === undefined || current === undefined) return;

    const box = current.tile.figure.getBoundingClientRect();

    drag.to = { x: event.clientX, y: event.clientY };
    showDrag();
    aim(
      speedOf((drag.to.x - drag.x) / box.width),
      speedOf((drag.to.y - drag.y) / box.height),
    );
  });

  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, () => {
      if (drag !== undefined) halt();
    });
  }

  // Leaving the window or the page mid-drag stops it too
  window.addEventListener("blur", halt);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) halt();
  });

  let wheeled = 0;

  area?.addEventListener(
    "wheel",
    (event) => {
      if (
        !event.ctrlKey ||
        current === undefined ||
        !lensZoom() ||
        !event.composedPath().includes(current.tile.figure)
      ) {
        return;
      }

      event.preventDefault();
      wheeled += event.deltaY;

      if (Math.abs(wheeled) < wheelStep) return;

      stepZoom(wheeled < 0 ? 1 : -1);
      wheeled = 0;
    },
    { passive: false },
  );

  /** The arrow keys held, which steer together, such as up and left. */
  const held = new Set<string>();

  const key: Steering["key"] = (pressed, down) => {
    if (!on) return;

    if (down) held.add(pressed);
    else held.delete(pressed);

    const pan =
      (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0);

    const tilt =
      (held.has("ArrowDown") ? 1 : 0) - (held.has("ArrowUp") ? 1 : 0);

    if (pan === 0 && tilt === 0) {
      if (drag === undefined) halt();

      return;
    }

    aim(pan * keySpeed, tilt * keySpeed);
  };

  return {
    on: () => on,
    toggle,
    leave,
    show,
    steers: (figure, gesture) =>
      on &&
      current !== undefined &&
      current.tile.figure === figure &&
      (gesture === "drag" || lensZoom()),
    key,
    zoomStep: stepZoom,
  };
};
