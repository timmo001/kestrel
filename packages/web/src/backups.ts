/**
 * The Backups panel in Settings: makes a backup of the settings, the
 * server's own files, such as its paired devices, and the recordings, all of
 * them, some cameras' or none, to download or keep on the server; lists the
 * ones kept there; and restores one of those or a file from this device,
 * after asking what to do with the recordings already here and for a locked
 * one's passphrase. The server restarts once it's read the backup, and the
 * page loads again when it's back.
 */
import { type Camera, version, versionHeader } from "@timmo001/kestrel-core";
import {
  type BackupFile,
  type BackupRequest,
  lockedMark,
  passphraseHeader,
  type RestoreMode,
} from "@timmo001/kestrel-server/api";
import { Option, Schema } from "effect";
import { call, serverUrl } from "./api.ts";
import { ownLabel } from "./cameras.ts";
import {
  phArchive,
  phArrowCounterClockwise,
  phDownloadSimple,
  phTrash,
  phUploadSimple,
} from "./icons.ts";
import { group } from "./settings.ts";
import { dateTimeFormat, element, find, isoDay } from "./shared.ts";

export interface BackupsPanel {
  /** Loads the cameras and the backups on the server, and shows them. */
  readonly start: () => Promise<void>;
}

/** A backup to restore: one on the server, by name, or a file from this device. */
type Chosen =
  | { readonly name: string; readonly locked: boolean }
  | { readonly file: File; readonly locked: boolean };

const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

/** Which recordings a backup takes: every camera's, some cameras', or none. */
const RecordingsChoice = Schema.Literals(["all", "some", "none"]);

type RecordingsChoice = typeof RecordingsChoice.Type;

const isRecordingsChoice = Schema.is(RecordingsChoice);

/** A size in words, such as `12 KB` or `3.4 GB`. */
const sizeText = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : bytes < 1024 ** 3
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

const button = (
  text: string,
  icon: string,
  variant: "neutral" | "danger" = "neutral",
) => {
  const created = element("gw-button", text);

  created.setAttribute("icon", icon);
  created.setAttribute("appearance", "outlined");
  created.setAttribute("variant", variant);

  return created;
};

/** Saves what's at `path` on the server as a file, without leaving the page. */
const save = (path: string) => {
  const link = element("a");

  link.href = serverUrl(path).href;
  link.download = "";
  link.click();
};

/** Sends a backup from this device to restore, telling `progress` how much is sent. */
const upload = (
  file: File,
  recordings: RestoreMode,
  passphrase: string,
  progress: (sent: number) => void,
) =>
  new Promise<void>((resolve, reject) => {
    // Not fetch, which can't tell how much of a large file is sent
    const request = new XMLHttpRequest();

    request.open(
      "POST",
      serverUrl(`api/backups/restore?recordings=${recordings}`),
    );
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader(versionHeader, version);

    if (passphrase !== "") {
      request.setRequestHeader(
        passphraseHeader,
        encodeURIComponent(passphrase),
      );
    }

    request.upload.addEventListener("progress", (event) =>
      progress(event.loaded),
    );
    request.addEventListener("load", () => {
      if (request.status < 300) {
        resolve();

        return;
      }

      const failure = decodeFailure(request.responseText);

      reject(
        new Error(
          Option.match(failure, {
            onNone: () => `The server said ${request.status}`,
            onSome: (each) => each.message,
          }),
        ),
      );
    });
    request.addEventListener("error", () =>
      reject(new Error("The upload stopped before the server had it all")),
    );
    request.send(file);
  });

export const backupsPanel = (): BackupsPanel => {
  const panel = find("gw-expansion", "settings-backups");
  const notice = element("gw-alert");
  const table = element("gw-table");
  const dialog = element("gw-dialog");

  // The make form's choices
  let cameras: ReadonlyArray<Camera> = [];
  let recordings: RecordingsChoice = "all";
  let days: "all" | "some" = "all";
  const picked = new Set<string>();

  const say = (message: string, tone: "danger" | "success" | "neutral") => {
    notice.textContent = message;
    notice.setAttribute("tone", tone);
    notice.hidden = message === "";
  };

  notice.hidden = true;

  const load = async () => {
    const backups = await call((api) => api.backups.list()).catch(
      (): ReadonlyArray<BackupFile> => [],
    );

    table.rows = backups.map((backup) => ({
      key: backup.name,
      name: backup.name,
      made:
        backup.modified === ""
          ? ""
          : dateTimeFormat.format(new Date(backup.modified)),
      bytes: sizeText(backup.bytes),
      locked: backup.locked ? "Passphrase" : "None",
    }));
  };

  /** Waits for the backup job to end, then lists it. */
  const followBackup = async () => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const jobs = await call((api) => api.activity.jobs()).catch(() => []);
      const job = jobs.find((each) => each.id === "backup");

      if (job?.state === "running") {
        say(
          job.progress === undefined
            ? job.detail
            : `${job.detail}: ${job.progress.done} of ${job.progress.total} files, ${sizeText(job.progress.bytes)}`,
          "neutral",
        );
        continue;
      }

      if (job?.state === "failed") say(job.detail, "danger");
      else if (job !== undefined) say(job.detail, "success");

      await load();

      return;
    }
  };

  // Making a backup
  const recordingsChoice = element("gw-segmented");
  const daysChoice = element("gw-segmented");
  const picks = element("gw-grid");
  const from = element("gw-date-picker");
  const to = element("gw-date-picker");
  const dayRange = element("gw-grid");
  const passphrase = element("gw-input");
  const download = button("Download", phDownloadSimple);
  const keep = button("Keep on the server", phArchive);

  recordingsChoice.label = "Recordings";
  recordingsChoice.options = [
    { value: "all", label: "Every camera" },
    { value: "some", label: "Some cameras" },
    { value: "none", label: "None" },
  ];
  recordingsChoice.value = recordings;

  daysChoice.label = "Days";
  daysChoice.options = [
    { value: "all", label: "Every day" },
    { value: "some", label: "Some days" },
  ];
  daysChoice.value = days;

  picks.style.setProperty("--gw-grid-min", "12rem");
  dayRange.style.setProperty("--gw-grid-min", "12rem");
  from.label = "From";
  to.label = "To";
  dayRange.append(from, to);

  passphrase.label = "Passphrase";
  passphrase.type = "password";
  passphrase.reveal = true;
  passphrase.optional = true;
  passphrase.autocomplete = "new-password";
  passphrase.hint =
    "Locks the backup, which holds the sources' logins. Restoring it needs this, and it can't be got back.";

  const showChoices = () => {
    picks.hidden = recordings !== "some";
    daysChoice.hidden = recordings === "none";
    dayRange.hidden = recordings === "none" || days !== "some";

    picks.replaceChildren(
      ...cameras.map((camera) => {
        const box = element("gw-checkbox");

        box.label = camera.label ?? ownLabel(camera);
        box.checked = picked.has(camera.id);
        box.addEventListener("change", () => {
          if (box.checked) picked.add(camera.id);
          else picked.delete(camera.id);
        });

        return box;
      }),
    );
  };

  recordingsChoice.addEventListener("change", () => {
    if (isRecordingsChoice(recordingsChoice.value)) {
      recordings = recordingsChoice.value;
    }

    showChoices();
  });

  daysChoice.addEventListener("change", () => {
    days = daysChoice.value === "some" ? "some" : "all";

    // The last week, until another's picked
    if (days === "some" && from.value === "") {
      const today = new Date();

      to.value = isoDay(today);
      from.value = isoDay(
        new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6),
      );
    }

    showChoices();
  });

  /** What's missing from the form, if anything. */
  const problem = () => {
    if (recordings === "some" && picked.size === 0) {
      return "Pick the cameras whose recordings to include";
    }

    if (recordings !== "none" && days === "some" && from.value > to.value) {
      return "The first day needs to come before the last";
    }

    return undefined;
  };

  /** The backup the form asks for. */
  const request = (): BackupRequest => {
    const dated = recordings !== "none" && days === "some";

    return {
      recordings: recordings === "none" ? false : undefined,
      cameras: recordings === "some" ? [...picked] : undefined,
      from: dated ? from.value : undefined,
      to: dated ? to.value : undefined,
      passphrase: passphrase.value === "" ? undefined : passphrase.value,
    };
  };

  download.addEventListener("click", () => {
    const missing = problem();

    if (missing !== undefined) {
      say(missing, "danger");

      return;
    }

    download.loading = true;
    void call((api) => api.backups.link({ payload: request() }))
      .then(({ path }) => {
        save(path);
        say(
          "The backup downloads as it's made, so a large one takes a while.",
          "success",
        );
      })
      .catch((error) =>
        say(error instanceof Error ? error.message : String(error), "danger"),
      )
      .finally(() => {
        download.loading = false;
      });
  });

  keep.addEventListener("click", () => {
    const missing = problem();

    if (missing !== undefined) {
      say(missing, "danger");

      return;
    }

    keep.loading = true;
    void call((api) => api.backups.create({ payload: request() }))
      .then(({ name }) => {
        say(`Making ${name}. Activity shows how it's getting on.`, "neutral");

        return followBackup();
      })
      .catch((error) =>
        say(error instanceof Error ? error.message : String(error), "danger"),
      )
      .finally(() => {
        keep.loading = false;
      });
  });

  const actions = element("gw-row");

  actions.append(download, keep);

  // Restoring, from the list or a file, after asking how
  const fromFile = button("Restore from a file", phUploadSimple);
  const fileInput = element("input");
  const modeChoice = element("gw-segmented");
  const restorePassphrase = element("gw-input");
  const progress = element("p");
  const restoreButton = button("Restore", phArrowCounterClockwise, "danger");
  const cancel = element("gw-button", "Cancel");
  let chosen: Chosen | undefined;
  let restoring = false;

  fileInput.type = "file";
  fileInput.accept = ".kestrel-backup";
  fileInput.hidden = true;

  modeChoice.label = "Recordings already here";
  modeChoice.options = [
    {
      value: "merge",
      label: "Keep them",
      hint: "Keeps the recordings here and adds the backup's",
    },
    {
      value: "replace",
      label: "Replace them",
      hint: "Deletes Kestrel's recordings here, then puts the backup's in",
    },
  ];
  modeChoice.value = "merge";

  restorePassphrase.label = "Passphrase";
  restorePassphrase.type = "password";
  restorePassphrase.reveal = true;
  restorePassphrase.autocomplete = "off";

  cancel.setAttribute("appearance", "plain");
  cancel.setAttribute("variant", "neutral");
  cancel.addEventListener("click", () => dialog.close());
  cancel.slot = "actions";
  restoreButton.slot = "actions";
  restoreButton.setAttribute("appearance", "filled");

  dialog.append(
    element(
      "p",
      "The settings, the server's id and its paired devices become the backup's, and the server starts again. A browser the backup doesn't know has to pair again.",
    ),
    group(
      "Recordings already here",
      "Either way, the backup's recordings are put back.",
      modeChoice,
    ),
    restorePassphrase,
    progress,
    cancel,
    restoreButton,
  );

  const ask = (backup: Chosen) => {
    chosen = backup;
    dialog.heading = `Restore ${"name" in backup ? backup.name : backup.file.name}`;
    restorePassphrase.hidden = !backup.locked;
    restorePassphrase.value = "";
    progress.textContent = "";
    restoreButton.loading = false;
    restoreButton.disabled = false;
    dialog.show();
  };

  /** Waits for the server to read the backup and start again, then loads the page again. */
  const followRestore = async () => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const jobs = await call((api) => api.activity.jobs()).catch(
        () => undefined,
      );

      if (jobs === undefined) {
        progress.textContent = "Waiting for the server to start again…";
        continue;
      }

      const job = jobs.find((each) => each.id === "restore");

      // A server that started again has no restore job yet
      if (job === undefined) {
        location.reload();

        return;
      }

      if (job.state === "failed") {
        progress.textContent = job.detail;
        restoring = false;
        restoreButton.loading = false;

        return;
      }

      progress.textContent =
        job.progress === undefined
          ? job.detail
          : `Reading the backup: ${job.progress.done} of ${job.progress.total} files, ${sizeText(job.progress.bytes)}`;
    }
  };

  restoreButton.addEventListener("click", () => {
    if (chosen === undefined || restoring) return;

    const backup = chosen;

    const mode: RestoreMode =
      modeChoice.value === "replace" ? "replace" : "merge";

    const secret = backup.locked ? restorePassphrase.value : "";

    if (backup.locked && secret === "") {
      progress.textContent = "This backup is locked: type its passphrase.";

      return;
    }

    restoring = true;
    restoreButton.loading = true;
    progress.textContent = "Starting…";

    const started =
      "name" in backup
        ? call((api) =>
            api.backups.restore({
              params: { name: backup.name },
              payload: {
                recordings: mode,
                passphrase: secret === "" ? undefined : secret,
              },
            }),
          )
        : upload(backup.file, mode, secret, (sent) => {
            progress.textContent = `Sending the backup: ${sizeText(sent)} of ${sizeText(backup.file.size)}`;
          });

    void started.then(followRestore).catch((error) => {
      progress.textContent =
        error instanceof Error ? error.message : String(error);
      restoring = false;
      restoreButton.loading = false;
    });
  });

  // While a restore runs, the dialog stays open
  dialog.addEventListener("close", () => {
    if (restoring) dialog.show();
  });

  fromFile.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];

    fileInput.value = "";

    if (file === undefined) return;

    void file
      .slice(0, lockedMark.length)
      .text()
      .then((start) => ask({ file, locked: start === lockedMark }));
  });

  table.setAttribute("row-key", "key");
  table.emptyLabel = "No backups are kept on the server yet.";
  table.columns = [
    { id: "made", header: "Made", wide: true },
    { id: "bytes", header: "Size", sortable: false },
    { id: "locked", header: "Lock", sortable: false },
    {
      id: "actions",
      header: "",
      sortable: false,
      cell: (row) => {
        const name = String(row["name"]);
        const cells = element("gw-row");
        const get = element("gw-button", "Download");
        const restore = element("gw-button", "Restore");
        const remove = element("gw-button", "Delete");

        cells.setAttribute("nowrap", "");

        for (const [each, icon] of [
          [get, phDownloadSimple],
          [restore, phArrowCounterClockwise],
          [remove, phTrash],
        ] as const) {
          each.setAttribute("icon", icon);
          each.setAttribute("size", "small");
          each.setAttribute("appearance", "plain");
          each.setAttribute("labels", "hide");
          each.setAttribute("label", `${each.textContent} ${name}`);
        }

        remove.setAttribute("variant", "danger");
        get.addEventListener("click", () =>
          save(`api/backups/files/${encodeURIComponent(name)}`),
        );
        restore.addEventListener("click", () =>
          ask({ name, locked: row["locked"] !== "None" }),
        );
        remove.addEventListener("click", () => {
          void call((api) => api.backups.remove({ params: { name } })).then(
            load,
            (error) =>
              say(
                error instanceof Error ? error.message : String(error),
                "danger",
              ),
          );
        });
        cells.append(get, restore, remove);

        return cells;
      },
    },
  ];

  const restoreActions = element("gw-row");

  restoreActions.append(fromFile, fileInput);

  panel?.replaceChildren(
    group(
      "Make a backup",
      "The settings, the sources' logins, the server's id, its paired devices and its activity always go in. Choose which recordings do.",
      recordingsChoice,
      picks,
      daysChoice,
      dayRange,
      passphrase,
      actions,
    ),
    notice,
    group(
      "Kept on the server",
      "In the backups folder, in the server's state folder. Copy them somewhere else too, so they outlast the machine.",
      table,
    ),
    group(
      "Restore",
      "From a backup kept on the server, with its Restore button, or from a file on this device.",
      restoreActions,
    ),
    dialog,
  );

  showChoices();

  return {
    start: async () => {
      cameras = await call((api) => api.cameras.list()).catch(() => cameras);
      showChoices();
      await load();
    },
  };
};
