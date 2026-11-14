/**
 * The Settings page: each source with the settings its kind takes and a
 * switch to turn it off without removing it, the cameras of a kind you list
 * yourself, the name you give each camera and whether it's on, the order
 * they show in, and what the server records and how long it keeps it.
 * Saving sends them all to the server, which keeps them in the sources file
 * and restarts the sources that changed. Secrets never come back from the
 * server: a saved one shows as saved, and stays as it is unless you type a
 * new one. A source whose cameras can send their clips to Kestrel has a
 * switch for it, which changes the camera at once rather than on a save.
 */
import {
  defaultClipHours,
  defaultContinuousHours,
  defaultDiskShare,
  defaultLimits,
  hoursText,
  limitRanges,
  SourceId,
  type Camera,
  type KindInfo,
  type RecordingSettings,
  type SettingField,
  type Settings,
  type UploadState,
} from "@timmo001/kestrel-core";
import { DirtyState, on, type MenuItem } from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import { call } from "./api.ts";
import { ownLabel } from "./cameras.ts";
import { phFloppyDisk, phPlus, phTrash } from "./icons.ts";
import { element, find } from "./shared.ts";

type Values = Record<string, string | number>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What the server records and keeps when nothing's saved yet. */
const defaultRecording = (): Mutable<RecordingSettings> => ({
  cameras: [],
  folder: null,
  continuousHours: defaultContinuousHours,
  clipHours: defaultClipHours,
  diskShare: defaultDiskShare,
  limits: defaultLimits,
});

/** A whole-number field, writing what's typed through `set`; the page checks its range before a save. */
const numberInput = (
  label: string,
  hint: (value: number) => string,
  value: number,
  set: (value: number) => void,
) => {
  const input = element("gw-input");

  input.label = label;
  input.type = "number";
  input.inputmode = "numeric";
  input.value = String(value);
  input.hint = hint(value);
  input.addEventListener("input", () => {
    const typed = Number(input.value);

    set(typed);
    input.hint = hint(typed);
  });

  return input;
};

/** A count of hours in words, such as `7 days`. */
const hoursHint = (value: number) =>
  Number.isInteger(value) && value >= 1
    ? hoursText(value)
    : "A whole number of hours, 1 or more";

const limitKeys = [
  "copyRate",
  "memoryFree",
  "memoryLimit",
  "cpuShare",
] as const;

/** A source as the page edits it. */
interface Draft {
  id: string;
  kind: string;
  name: string;
  /** Whether the server runs it; one that's off keeps its settings. */
  enabled: boolean;
  settings: Values;
  cameras: Array<Values>;
  /** The secret settings saved on the server, which it doesn't send back. */
  readonly secrets: ReadonlyArray<string>;
  /** Whether the server has it, so its id can't change any more. */
  readonly saved: boolean;
}

export interface SettingsOptions {
  /** After a save, so the other pages pick up new cameras and names. */
  readonly onSaved: () => Promise<void>;
}

export interface SettingsPage {
  /** Loads the kinds of source, the saved settings and the cameras, and shows them. */
  readonly start: () => Promise<void>;
}

const isSourceId = Schema.is(SourceId);

const button = (text: string, icon: string) => {
  const created = element("gw-button", text);

  created.setAttribute("icon", icon);
  created.setAttribute("appearance", "outlined");
  created.setAttribute("variant", "neutral");

  return created;
};

/** A field for one setting, writing what's typed into `values`. */
const settingInput = (
  field: SettingField,
  values: Values,
  savedSecret: boolean,
) => {
  const input = element("gw-input");
  const value = values[field.key];

  input.label = field.label;
  input.name = field.key;
  input.hint = field.hint ?? "";
  input.optional = !field.required;
  input.value = value === undefined ? "" : String(value);

  if (field.type === "secret") {
    input.type = "password";
    input.reveal = true;
    input.autocomplete = "new-password";
    input.placeholder = savedSecret ? "Saved; type to change it" : "";
  }

  if (field.type === "number") {
    input.type = "number";
    input.inputmode = "numeric";
  }

  // An address gets a row of its own, as it's often longer than the column
  if (field.type === "address") {
    input.monospace = true;
    input.style.gridColumn = "1 / -1";
  }

  input.addEventListener("input", () => {
    const typed = field.type === "secret" ? input.value : input.value.trim();

    if (typed === "") Reflect.deleteProperty(values, field.key);
    else values[field.key] = field.type === "number" ? Number(typed) : typed;
  });

  return input;
};

const fieldGrid = (fields: ReadonlyArray<HTMLElement>) => {
  const grid = element("gw-grid");

  grid.style.setProperty("--gw-grid-min", "16rem");
  grid.append(...fields);

  return grid;
};

/** A part of a source's card: a heading, a line on what it's for, and its fields. */
const group = (
  heading: string,
  description: string,
  ...content: ReadonlyArray<HTMLElement>
) => {
  const section = element("section");
  const intro = element("div");

  section.className = "settings-group";
  intro.append(element("h4", heading), element("p", description));
  section.append(intro, ...content);

  return section;
};

/** The first of `base`, `base-2`, `base-3` and on that `taken` doesn't have. */
const freeName = (base: string, taken: ReadonlyArray<unknown>) => {
  let name = base;

  for (let count = 2; taken.includes(name); count += 1) {
    name = `${base}-${count}`;
  }

  return name;
};

/** The Settings page, wired to its list, its Add source menu and its Save button. */
export const settingsPage = (options: SettingsOptions): SettingsPage => {
  const list = find("gw-stack", "settings-list");
  const notice = find("gw-alert", "settings-notice");
  const addMenu = find("gw-menu-button", "settings-add");
  const saveButton = find("gw-button", "settings-save");
  const orderList = find("gw-sortable", "settings-order-list");
  const recordingPanel = find("gw-expansion", "settings-recording");

  let kinds: ReadonlyArray<KindInfo> = [];
  let drafts: Array<Draft> = [];
  let cameras: ReadonlyArray<Camera> = [];

  /** The sources whose cameras can send their clips to Kestrel. */
  let uploadable = new Set<string>();

  /** Each camera's name, by its id. */
  let labels = new Map<string, string>();

  /** The version of the settings the page read, sent back with a save. */
  let revision = "";

  /** The order cameras show in, by id, as saved or as you dragged it. */
  let order: ReadonlyArray<string> = [];

  /** The cameras you've turned off, by id. */
  let off = new Set<string>();

  /** What the server records and keeps, as the page edits it. */
  let recording = defaultRecording();

  /** The source whose panel is open, kept across redraws. */
  let opened: Draft | undefined;

  /** The settings as the server last sent them, which leaving without saving goes back to. */
  let saved: Settings | undefined;

  // Save stays off until something changes, and leaving with changes asks first
  const dirty = new DirtyState<Settings>({
    discard: () => {
      if (saved === undefined) return;

      show(saved);
      render();
    },
  });

  dirty.subscribe((changed) => {
    if (saveButton !== null) saveButton.disabled = !changed;
  });

  const say = (message: string, tone: "danger" | "success") => {
    if (notice === null) return;

    notice.textContent = message;
    notice.setAttribute("tone", tone);
    notice.hidden = message === "";
  };

  const show = (settings: Settings) => {
    saved = settings;
    drafts = settings.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name,
      enabled: source.enabled,
      settings: { ...source.settings },
      cameras: source.cameras.map((camera) => ({ ...camera })),
      secrets: source.secrets,
      saved: true,
    }));
    labels = new Map(settings.cameras.map((each) => [each.camera, each.label]));
    order = settings.order;
    off = new Set(settings.off);
    recording = {
      cameras: settings.recording.cameras,
      folder: settings.recording.folder,
      continuousHours: settings.recording.continuousHours,
      clipHours: settings.recording.clipHours,
      diskShare: settings.recording.diskShare,
      limits: { ...settings.recording.limits },
    };
    revision = settings.revision ?? "";
    // The panel open before a save stays open after it
    opened = drafts.find((source) => source.id === opened?.id);
  };

  /** A field for each of a source's cameras' names and a switch to turn it off, once the server has them. */
  const labelInputs = (source: Draft) => {
    const own = cameras.filter((camera) => camera.source === source.id);

    if (own.length === 0) return [];

    const inputs = own.map((camera) => {
      const row = element("gw-row");
      const input = element("gw-input");
      const power = element("gw-switch");

      row.setAttribute("nowrap", "");
      row.setAttribute("align", "end");
      input.label = ownLabel(camera);
      input.placeholder = camera.name;
      input.value = labels.get(camera.id) ?? "";
      input.style.flex = "1";
      input.addEventListener("input", () => labels.set(camera.id, input.value));

      // Off keeps the camera's name and recordings, but shows no live video
      power.label = `Show ${ownLabel(camera)}`;
      power.labelHidden = true;
      power.checked = !off.has(camera.id);
      power.addEventListener("change", () => {
        if (power.checked) off.delete(camera.id);
        else off.add(camera.id);
      });
      row.append(input, power);

      return row;
    });

    return [
      group(
        "Cameras",
        "What each camera shows as across the app, and whether it's on. Leave a name empty to use its own. One that's off has no live video and isn't recorded.",
        fieldGrid(inputs),
      ),
    ];
  };

  const cameraCard = (
    source: Draft,
    fields: ReadonlyArray<SettingField>,
    camera: Values,
    at: number,
  ) => {
    const card = element("gw-card");
    const remove = button("Remove camera", phTrash);

    card.setAttribute("heading", `Camera ${at + 1}`);
    card.setAttribute("level", "4");
    remove.slot = "actions";
    remove.setAttribute("labels", "hide");
    remove.setAttribute("appearance", "plain");
    remove.addEventListener("click", () => {
      source.cameras.splice(at, 1);
      render();
    });
    card.append(
      remove,
      fieldGrid(fields.map((field) => settingInput(field, camera, false))),
    );

    return card;
  };

  /** A kind's cameras, for a kind you list them for yourself. */
  const cameraList = (source: Draft, fields: ReadonlyArray<SettingField>) => {
    const add = button("Add camera", phPlus);

    add.addEventListener("click", () => {
      source.cameras.push({
        id: freeName(
          String(source.cameras.length + 1),
          source.cameras.map((camera) => camera["id"]),
        ),
      });
      render();
    });

    const actions = element("gw-row");

    actions.append(add);

    return [
      group(
        "Cameras",
        "Each camera's stream addresses. A camera needs a stream or a still.",
        ...source.cameras.map((camera, at) =>
          cameraCard(source, fields, camera, at),
        ),
        actions,
      ),
    ];
  };

  /** A switch that points a source's cameras at Kestrel's own receiver, for a saved source whose cameras can send their clips. */
  const uploadsGroup = (source: Draft) => {
    if (!source.saved || !uploadable.has(source.id)) return [];

    const send = element("gw-switch");
    const result = element("gw-alert");
    const params = { source: source.id };

    const describe = (state: UploadState) => {
      send.checked = state.on;
      send.hint = state.on
        ? state.last === null
          ? "On. No clips have come yet."
          : `On. The last clip came ${new Date(state.last).toLocaleString()}.`
        : "When it sees motion, it sends each clip here as it records it, so a clip only on its card can be played.";
    };

    send.label = "Send clips to Kestrel";
    send.disabled = true;
    send.hint = "Asking the camera…";
    result.hidden = true;

    void call((api) => api.sources.uploads({ params }))
      .then((state) => {
        describe(state);
        send.disabled = false;
      })
      .catch((error) => {
        send.hint = `Can't ask the camera: ${error instanceof Error ? error.message : String(error)}`;
      });

    send.addEventListener("change", () => {
      const on = send.checked;

      send.disabled = true;
      send.hint = on ? "Setting up the camera and testing it…" : "Stopping it…";
      result.hidden = true;

      void call((api) => api.sources.sendUploads({ params, payload: { on } }))
        .then((check) => {
          result.textContent = check.message;
          result.setAttribute(
            "tone",
            check.tested === false ? "warning" : "success",
          );
          result.hidden = false;

          return call((api) => api.sources.uploads({ params }));
        })
        .then(describe)
        .catch((error) => {
          send.checked = !on;
          result.textContent =
            error instanceof Error ? error.message : String(error);
          result.setAttribute("tone", "danger");
          result.hidden = false;
        })
        .finally(() => {
          send.disabled = false;
        });
    });

    return [
      group(
        "Clips",
        "The camera sends its clips to Kestrel by FTP, and they're kept for the clip hours set under Recording. This changes the camera's FTP settings straight away.",
        send,
        result,
      ),
    ];
  };

  const sourceCard = (source: Draft, index: number) => {
    const kind = kinds.find((each) => each.kind === source.kind);
    const card = element("gw-expansion");
    const remove = button("Remove", phTrash);
    const power = element("gw-switch");
    const name = element("gw-input");

    const describe = () =>
      card.setAttribute(
        "description",
        [
          kind?.name ?? source.kind,
          source.id,
          ...(source.enabled ? [] : ["Off"]),
        ].join(" · "),
      );

    card.setAttribute(
      "heading",
      source.name === "" ? "New source" : source.name,
    );
    describe();
    card.open = source === opened;

    // One source open at a time: opening one closes the one open before
    card.addEventListener("toggle", () => {
      if (card.open) {
        opened = source;

        for (const other of list?.querySelectorAll("gw-expansion") ?? []) {
          if (other !== card) other.open = false;
        }
      } else if (opened === source) {
        opened = undefined;
      }
    });

    // Off keeps the source and its settings, but the server doesn't start it
    power.slot = "actions";
    power.label = `Run ${source.name.trim() || "this source"}`;
    power.labelHidden = true;
    power.checked = source.enabled;
    power.addEventListener("change", () => {
      source.enabled = power.checked;
      describe();
    });

    remove.slot = "actions";
    remove.setAttribute("variant", "danger");
    remove.setAttribute("appearance", "plain");
    remove.addEventListener("click", () => {
      drafts.splice(index, 1);
      render();
    });

    name.label = "Name";
    name.value = source.name;
    name.addEventListener("input", () => {
      source.name = name.value;
      card.setAttribute("heading", name.value.trim() || "New source");
    });

    const fields: Array<HTMLElement> = [name];

    if (!source.saved) {
      const id = element("gw-input");

      id.label = "Id";
      id.hint =
        "Lower-case letters, digits and dashes, used in links; it can't change once saved";
      id.monospace = true;
      id.value = source.id;
      id.addEventListener("input", () => {
        source.id = id.value.trim();
        describe();
      });
      fields.push(id);
    }

    for (const field of kind?.fields ?? []) {
      fields.push(
        settingInput(
          field,
          source.settings,
          source.secrets.includes(field.key),
        ),
      );
    }

    card.append(power, remove, fieldGrid(fields));

    if (kind === undefined) {
      const alert = element(
        "gw-alert",
        `The server has no kind of source called ${source.kind}.`,
      );

      alert.setAttribute("tone", "warning");
      card.append(alert);
    }

    if (kind?.cameraFields) {
      card.append(...cameraList(source, kind.cameraFields));
    }

    card.append(...labelInputs(source), ...uploadsGroup(source));

    return card;
  };

  /** The Recording panel: the cameras the server records, its folder, and how long it keeps each kind. */
  const recordingFields = () => {
    if (recordingPanel === null) return;

    // Only a camera with live video can be recorded, so the rest aren't offered
    const picks = cameras.flatMap((camera) => {
      if (camera.live === null && !recording.cameras.includes(camera.id)) {
        return [];
      }

      const box = element("gw-checkbox");

      box.label = labels.get(camera.id)?.trim() || ownLabel(camera);
      box.checked = recording.cameras.includes(camera.id);
      box.addEventListener("change", () => {
        recording.cameras = box.checked
          ? [...recording.cameras, camera.id]
          : recording.cameras.filter((id) => id !== camera.id);
      });

      return [box];
    });

    const folder = element("gw-input");

    folder.label = "Folder";
    folder.monospace = true;
    folder.optional = true;
    folder.placeholder = "The server's own";
    folder.hint =
      "Where recordings go, such as a share on a NAS. Empty uses recordings in the server's state folder.";
    folder.value = recording.folder ?? "";
    folder.addEventListener("input", () => {
      const typed = folder.value.trim();

      recording.folder = typed === "" ? null : typed;
    });

    const share = numberInput(
      "Disk share",
      (value) =>
        value >= 1 && value <= 90
          ? `Up to ${value}% of the disk, always leaving 5% free`
          : "A percentage from 1 to 90",
      recording.diskShare,
      (value) => {
        recording.diskShare = value;
      },
    );

    const limitInput = (
      key: keyof typeof limitRanges,
      label: string,
      hint: (value: number) => string,
    ) => {
      const range = limitRanges[key];

      return numberInput(
        label,
        (value) =>
          value >= range.minimum && value <= range.maximum
            ? hint(value)
            : `From ${range.minimum} to ${range.maximum}`,
        recording.limits[key],
        (value) => {
          recording.limits = { ...recording.limits, [key]: value };
        },
      );
    };

    recordingPanel.replaceChildren(
      group(
        "Cameras to record",
        "The server records these itself, from their live streams, beside what their sources keep.",
        picks.length === 0
          ? element("p", "The cameras show here once their sources connect.")
          : fieldGrid(picks),
      ),
      group(
        "Keeping recordings",
        "The oldest go first. Past the disk share, what's furthest through its own hours goes first.",
        fieldGrid([
          numberInput(
            "Continuous footage, hours",
            hoursHint,
            recording.continuousHours,
            (value) => {
              recording.continuousHours = value;
            },
          ),
          numberInput(
            "Clips, hours",
            hoursHint,
            recording.clipHours,
            (value) => {
              recording.clipHours = value;
            },
          ),
          share,
          folder,
        ]),
      ),
      group(
        "Background work",
        "Copying recordings from sources and clearing out old ones wait while the machine or the server is past any of these. Live view and recording never wait. Activity shows how they're getting on.",
        fieldGrid([
          limitInput(
            "copyRate",
            "Copy rate, MB a second",
            (value) => `Copies read up to ${value} MB a second`,
          ),
          limitInput(
            "memoryFree",
            "Memory kept free, %",
            (value) =>
              `Waits while under ${value}% of the machine's memory is free`,
          ),
          limitInput(
            "memoryLimit",
            "Server memory, MB",
            (value) =>
              `Waits while the server, go2rtc and ffmpeg use over ${value} MB`,
          ),
          limitInput(
            "cpuShare",
            "Server CPU, %",
            (value) => `Waits while the server uses over ${value}% of the CPU`,
          ),
        ]),
      ),
    );
  };

  const render = () => {
    recordingFields();

    if (orderList !== null) {
      // The server lists cameras in their order already
      orderList.items = cameras.map((camera) => ({
        value: camera.id,
        label: labels.get(camera.id)?.trim() || ownLabel(camera),
        description:
          drafts.find((source) => source.id === camera.source)?.name ??
          camera.source,
      }));
    }

    if (list === null) return;

    list.replaceChildren(
      ...(drafts.length === 0
        ? [element("p", "No sources yet. Add one to see its cameras.")]
        : drafts.map(sourceCard)),
    );

    // Adding or removing a source or a camera is a change too
    dirty.update(payload());
  };

  const addSource = (kind: KindInfo) => {
    drafts.push({
      id: freeName(
        kind.kind,
        drafts.map((source) => source.id),
      ),
      kind: kind.kind,
      name: kind.name,
      enabled: true,
      settings: {},
      cameras: kind.cameraFields === null ? [] : [{ id: "1" }],
      secrets: [],
      saved: false,
    });
    // A new source opens, ready to fill in
    opened = drafts.at(-1);
    render();
    list?.lastElementChild?.scrollIntoView({ block: "start" });
  };

  if (addMenu !== null) {
    addMenu.setAttribute("icon", phPlus);
    on(addMenu, "select", (event) => {
      const kind = kinds.find((each) => each.kind === event.detail.value);

      if (kind !== undefined) addSource(kind);
    });
  }

  /** What the page can tell is wrong before it sends them. */
  const problems = () => [
    ...drafts.flatMap((source) =>
      isSourceId(source.id)
        ? []
        : [
            `${source.name.trim() || "A new source"} needs an id of lower-case letters, digits and dashes`,
          ],
    ),
    ...(
      [
        { what: "Continuous footage", value: recording.continuousHours },
        { what: "Clips", value: recording.clipHours },
      ] as const
    ).flatMap(({ what, value }) =>
      Number.isInteger(value) && value >= 1
        ? []
        : [`${what} needs a whole number of hours, 1 or more`],
    ),
    ...(recording.diskShare >= 1 && recording.diskShare <= 90
      ? []
      : ["The disk share needs to be from 1 to 90"]),
    ...(limitKeys.every(
      (key) =>
        recording.limits[key] >= limitRanges[key].minimum &&
        recording.limits[key] <= limitRanges[key].maximum,
    )
      ? []
      : ["Each background work limit needs to be in its range"]),
  ];

  const payload = (): Settings => ({
    sources: drafts.map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name.trim(),
      enabled: source.enabled,
      settings: source.settings,
      cameras: source.cameras,
      secrets: [],
    })),
    cameras: [...labels].flatMap(([camera, label]) =>
      label.trim() === "" ? [] : [{ camera, label: label.trim() }],
    ),
    order,
    off: [...off],
    recording,
    revision,
  });

  const loadCameras = () =>
    call((api) => api.cameras.list()).catch(() => cameras);

  const loadUploadable = () =>
    call((api) => api.sources.list())
      .then(
        (all) =>
          new Set(
            all.filter((source) => source.uploads).map((source) => source.id),
          ),
      )
      .catch(() => uploadable);

  const save = async () => {
    const found = problems();

    if (found.length > 0) {
      say(found.join("; "), "danger");

      return;
    }

    if (saveButton !== null) saveButton.loading = true;

    try {
      const stored = await call((api) =>
        api.sources.save({ payload: payload() }),
      );

      show(stored);
      say("Saved. The sources you changed are starting again.", "success");
      await options.onSaved();
      [cameras, uploadable] = await Promise.all([
        loadCameras(),
        loadUploadable(),
      ]);
      render();
      dirty.start(payload());
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      if (saveButton !== null) saveButton.loading = false;
    }
  };

  if (saveButton !== null) {
    saveButton.setAttribute("icon", phFloppyDisk);
    saveButton.disabled = true;
    saveButton.addEventListener("click", () => void save());
  }

  if (orderList !== null) {
    orderList.addEventListener("change", () => {
      order = orderList.items.map((item) => item.value);
    });
  }

  // Each field's own listener writes its value first, then this compares
  for (const type of ["input", "change"]) {
    list?.closest(".page")?.addEventListener(type, () => {
      dirty.update(payload());
    });
  }

  const start = async () => {
    try {
      const [loadedKinds, settings, known, sending] = await Promise.all([
        call((api) => api.sources.kinds()),
        call((api) => api.sources.settings()),
        loadCameras(),
        loadUploadable(),
      ]);

      kinds = loadedKinds;
      cameras = known;
      uploadable = sending;
      show(settings);

      if (addMenu !== null) {
        addMenu.items = kinds.map((kind): MenuItem => ({
          value: kind.kind,
          label: kind.name,
          description: kind.description,
        }));
      }

      render();
      dirty.start(payload());
    } catch (error) {
      say(
        `The settings can't be loaded yet: ${error instanceof Error ? error.message : String(error)}`,
        "danger",
      );
      setTimeout(() => void start(), 5000);
    }
  };

  return { start };
};
