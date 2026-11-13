/**
 * The Activity page: what the server does by itself and how much of the
 * machine it uses. Each job, such as copying recordings from sources,
 * recording a camera or clearing out old recordings, with what it's doing,
 * how far through it is and its last error; the last 7 days of errors from
 * the activity log; the recordings copied most lately and what each
 * camera's recordings take on disk; and the server's memory and CPU, used
 * and allowed, with the machine's and the last hour of each. Each table has
 * a quick search and filters. It reads them again every 10 seconds while
 * it's open.
 */
import type { TableRow } from "@timmo001/groundwork-ui";
import {
  JobState,
  type Job,
  type LogEntry,
  type UsageReport,
  type UsageSample,
} from "@timmo001/kestrel-server/api";
import { Schema } from "effect";
import { call } from "./api.ts";
import { cameraLabel } from "./cameras.ts";
import { dateTimeFormat, element, find, timeFormat } from "./shared.ts";
import { filteredTable } from "./table-filters.ts";

/** How often the page reads them again while it's open. */
const every = 10_000;

const isJobState = Schema.is(JobState);

const megabyte = 1024 * 1024;

const gigabyte = 1024 * megabyte;

const bytesText = (bytes: number) =>
  bytes >= gigabyte
    ? `${(bytes / gigabyte).toFixed(1)} GB`
    : `${Math.round(bytes / megabyte)} MB`;

const stateTones: Record<JobState, string> = {
  idle: "neutral",
  running: "success",
  waiting: "warning",
  failed: "danger",
};

const stateNames: Record<JobState, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  failed: "Failed",
};

const when = (iso: string | undefined) =>
  iso === undefined || iso === "" ? "" : dateTimeFormat.format(new Date(iso));

/**
 * A long text cell. On a phone, `--activity-text-width` keeps it wide enough
 * to read, and the table scrolls across, rather than it wrapping a word to a
 * line.
 */
const longText = (text: string) => {
  const span = element("span", text);

  span.style.display = "block";
  span.style.minInlineSize = "var(--activity-text-width, 0)";
  span.style.whiteSpace = "normal";

  return span;
};

/**
 * A small line graph of the last hour, as an SVG drawn in the accent
 * colour, scaled from 0 to `top`, or the highest value where that's higher,
 * with a dashed line at `limit` when there is one.
 */
const graph = (
  label: string,
  samples: ReadonlyArray<UsageSample>,
  value: (sample: UsageSample) => number,
  top: number,
  limit: number | undefined,
) => {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const line = document.createElementNS(namespace, "polyline");
  const width = 300;
  const height = 48;
  const values = samples.map(value);
  const highest = Math.max(top, ...values, 1);
  const y = (each: number) => (height - (each / highest) * height).toFixed(1);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${label} over the last hour`);
  svg.classList.add("usage-graph");

  if (limit !== undefined) {
    const rule = document.createElementNS(namespace, "line");

    rule.setAttribute("x1", "0");
    rule.setAttribute("x2", String(width));
    rule.setAttribute("y1", y(limit));
    rule.setAttribute("y2", y(limit));
    rule.classList.add("usage-limit");
    svg.append(rule);
  }

  line.setAttribute(
    "points",
    values
      .map(
        (each, index) =>
          `${((index / Math.max(values.length - 1, 1)) * width).toFixed(1)},${y(each)}`,
      )
      .join(" "),
  );
  svg.append(line);

  return svg;
};

/**
 * A meter of what's used out of all there is, turning warning past what
 * background work is allowed, with the last hour's graph under it and the
 * allowance as a dashed line across it.
 */
const usageMeter = (options: {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  /** What background work is allowed, on the same scale as `value`. */
  readonly allowed?: number | undefined;
  readonly display: string;
  readonly caption: string;
  readonly history?: ReadonlyArray<UsageSample>;
  readonly of?: (sample: UsageSample) => number;
}) => {
  const wrap = element("div");
  const meter = element("gw-meter");
  const { history, of, allowed } = options;

  meter.label = options.label;
  meter.value = options.value;
  meter.max = options.max;
  meter.high = allowed;
  meter.display = options.display;
  meter.caption = options.caption;
  wrap.className = "usage-meter";
  wrap.append(meter);

  if (history !== undefined && of !== undefined && history.length > 1) {
    // Scaled to just past the allowance, so both the line and the limit show
    wrap.append(
      graph(
        options.label,
        history,
        of,
        allowed === undefined ? options.max : allowed * 1.25,
        allowed,
      ),
    );
  }

  return wrap;
};

const card = (heading: string, ...content: ReadonlyArray<Node>) => {
  const created = element("gw-card");

  created.setAttribute("heading", heading);
  created.append(...content);

  return created;
};

/**
 * The server's memory and CPU: what it uses out of the whole machine, and
 * what background work is allowed. Past an allowance, background work waits;
 * live view and recording carry on, so it's not a hard cap.
 */
const serverCard = (usage: UsageReport) => {
  const { now, limits, history } = usage;
  const cores = Math.max(now.cores, 1);
  const cpu = now.kestrelCpu / cores;
  const memory = now.kestrelMemory / megabyte;

  return card(
    "Server",
    usageMeter({
      label: "Memory",
      value: memory,
      max: Math.max(now.memory / megabyte, memory, 1),
      allowed: limits.memoryLimit,
      display: `${bytesText(now.kestrelMemory)} used · ${limits.memoryLimit} MB allowed`,
      caption: `The server, go2rtc and ffmpeg, of ${bytesText(now.memory)}. Background work waits past ${limits.memoryLimit} MB`,
      history,
      of: (sample) => sample.kestrelMemory / megabyte,
    }),
    usageMeter({
      label: "CPU",
      value: cpu,
      max: 100,
      allowed: limits.cpuShare,
      display: `${Math.round(cpu)}% used · ${limits.cpuShare}% allowed`,
      caption: `Of all ${cores} cores. Background work waits past ${limits.cpuShare}%`,
      history,
      of: (sample) => sample.kestrelCpu / Math.max(sample.cores, 1),
    }),
  );
};

/** The machine's memory and load. */
const machineCard = (usage: UsageReport) => {
  const { now, limits, history } = usage;
  const used = now.memory - now.memoryFree;
  const keep = (now.memory * limits.memoryFree) / 100;
  const facts = element("gw-facts");

  facts.items = [
    { label: "Load", value: `${now.load.toFixed(2)} on ${now.cores} cores` },
    { label: "Swap in use", value: bytesText(now.swapUsed) },
    {
      label: "Waiting on memory",
      value: `${now.memoryPressure.toFixed(1)}% of the time`,
    },
    {
      label: "Waiting on disks",
      value: `${now.diskPressure.toFixed(1)}% of the time`,
    },
  ];

  return card(
    "Machine",
    usageMeter({
      label: "Memory in use",
      value: (used / Math.max(now.memory, 1)) * 100,
      max: 100,
      allowed: 100 - limits.memoryFree,
      display: `${bytesText(used)} of ${bytesText(now.memory)} · ${bytesText(keep)} kept free`,
      caption: `${bytesText(now.memoryFree)} free. Background work waits under ${limits.memoryFree}% free`,
      history,
      of: (sample) =>
        ((sample.memory - sample.memoryFree) / Math.max(sample.memory, 1)) *
        100,
    }),
    facts,
  );
};

/** The recordings folder's disk, and what each camera's recordings take. */
const diskCard = (usage: UsageReport) => {
  const disk = usage.disk;

  if (disk === undefined) {
    return card(
      "Recordings",
      element("p", "Counted once there's a recordings folder."),
    );
  }

  const used = disk.total - disk.free;
  const meter = element("gw-meter");
  const table = element("gw-table");
  const allowed = disk.allowed;

  meter.label = "Disk in use";
  meter.value = (used / Math.max(disk.total, 1)) * 100;
  meter.high = 85;
  meter.critical = 95;
  meter.display = `${bytesText(used)} of ${bytesText(disk.total)}`;
  meter.caption = `${bytesText(disk.free)} free${disk.counted === undefined ? "" : `, counted ${timeFormat.format(new Date(disk.counted))}`}`;

  // What recordings take against what they may, past which the oldest go
  const share = usageMeter({
    label: "Recordings",
    value: disk.recordings,
    max: Math.max(allowed ?? disk.total, disk.recordings, 1),
    allowed: allowed === undefined ? undefined : allowed * 0.95,
    display:
      allowed === undefined
        ? bytesText(disk.recordings)
        : `${bytesText(disk.recordings)} used · ${bytesText(allowed)} allowed`,
    caption:
      disk.diskShare === undefined
        ? "The oldest go first past what they may use"
        : `Up to ${disk.diskShare}% of the disk. The oldest go first past it`,
  });

  table.setAttribute("label", "Recordings by camera");
  table.setAttribute("row-key", "camera");
  table.setAttribute("search", "never");
  table.setAttribute("empty-label", "No recordings yet");
  table.columns = [
    { id: "label", header: "Camera" },
    { id: "files", header: "Files", numeric: true },
    {
      id: "bytes",
      header: "Size",
      numeric: true,
      cell: (row) => bytesText(Number(row.bytes)),
    },
  ];
  table.rows = disk.cameras.map((camera): TableRow => ({
    camera: camera.camera,
    label: cameraLabel(camera.camera),
    files: camera.files,
    bytes: camera.bytes,
  }));

  return card("Recordings", meter, share, table);
};

const kindNames = {
  copy: "Copying",
  record: "Recording",
  "clear-out": "Clearing out",
} satisfies Record<Job["kind"], string>;

/** A job's name, with a recording job's camera by its own name. */
const jobName = (id: string, name: string) =>
  id.startsWith("record:")
    ? `Record ${cameraLabel(id.slice("record:".length))}`
    : name;

const jobRow = (job: Job): TableRow => ({
  id: job.id,
  kind: job.kind,
  kindName: kindNames[job.kind],
  name: jobName(job.id, job.name),
  state: job.state,
  detail: job.detail,
  since: when(job.since),
  progress:
    job.progress === undefined
      ? ""
      : `${job.progress.done} of ${job.progress.total}, ${bytesText(job.progress.bytes)}`,
  lastRun:
    job.lastRun === undefined
      ? ""
      : `${job.lastRun.summary}, ${when(job.lastRun.at)}`,
  lastError:
    job.lastError === undefined
      ? ""
      : `${job.lastError.message}, ${when(job.lastError.at)}`,
});

const jobsTable = () =>
  filteredTable({
    key: "kestrel-activity-jobs",
    label: "Jobs",
    rowKey: "id",
    empty: "No jobs yet",
    columns: [
      { id: "name", header: "Job" },
      {
        id: "state",
        header: "State",
        cell: (row) => {
          const state = isJobState(row.state) ? row.state : "idle";
          const chip = element("gw-chip", stateNames[state]);

          chip.setAttribute("tone", stateTones[state]);

          return chip;
        },
      },
      {
        id: "detail",
        header: "Doing",
        wide: true,
        cell: (row) => longText(String(row.detail ?? "")),
      },
      { id: "since", header: "Since" },
      { id: "progress", header: "This pass" },
      {
        id: "lastRun",
        header: "Last run",
        wide: true,
        cell: (row) => longText(String(row.lastRun ?? "")),
      },
      {
        id: "lastError",
        header: "Last error",
        wide: true,
        cell: (row) => longText(String(row.lastError ?? "")),
      },
    ],
    filters: [
      {
        id: "state",
        label: "State",
        many: "states",
        of: (row) => {
          const state = isJobState(row.state) ? row.state : "idle";

          return { value: state, label: stateNames[state] };
        },
      },
      {
        id: "kind",
        label: "Kind",
        many: "kinds",
        of: (row) => ({
          value: String(row.kind),
          label: String(row.kindName),
        }),
      },
    ],
  });

/** A camera's source, from its id, such as `swann` for `swann/4`. */
const sourceOf = (camera: string) => camera.split("/")[0] ?? camera;

/** The copy job's newest recordings, newest first. */
const copiedTable = () =>
  filteredTable({
    key: "kestrel-activity-copied",
    label: "Copied lately",
    rowKey: "key",
    empty: "Nothing copied since the server started",
    sort: "at",
    time: "at",
    columns: [
      { id: "label", header: "Camera" },
      {
        id: "begin",
        header: "Recording from",
        cell: (row) => when(String(row.begin)),
      },
      {
        id: "bytes",
        header: "Size",
        numeric: true,
        searchable: false,
        cell: (row) => bytesText(Number(row.bytes)),
      },
      { id: "at", header: "Copied", cell: (row) => when(String(row.at)) },
    ],
    filters: [
      {
        id: "source",
        label: "Source",
        many: "sources",
        of: (row) => ({
          value: sourceOf(String(row.camera)),
          label: sourceOf(String(row.camera)),
        }),
      },
      {
        id: "camera",
        label: "Camera",
        many: "cameras",
        of: (row) => ({ value: String(row.camera), label: String(row.label) }),
      },
    ],
  });

const copiedRows = (jobs: ReadonlyArray<Job>) =>
  jobs
    .flatMap((job) => job.recent ?? [])
    .map((each): TableRow => ({
      key: `${each.camera}-${each.begin}`,
      camera: each.camera,
      label: cameraLabel(each.camera),
      begin: each.begin,
      bytes: each.bytes,
      at: each.at,
    }));

/** The activity log's errors, newest first, kept by the server for 7 days. */
const errorsTable = () =>
  filteredTable({
    key: "kestrel-activity-errors",
    label: "Errors",
    rowKey: "key",
    empty: "No errors in the last 7 days",
    sort: "at",
    time: "at",
    columns: [
      { id: "at", header: "When", cell: (row) => when(String(row.at)) },
      { id: "name", header: "Job" },
      {
        id: "message",
        header: "Error",
        wide: true,
        cell: (row) => longText(String(row.message ?? "")),
      },
    ],
    filters: [
      {
        id: "job",
        label: "Job",
        many: "jobs",
        of: (row) => ({ value: String(row.job), label: String(row.name) }),
      },
    ],
  });

const errorRows = (entries: ReadonlyArray<LogEntry>) =>
  entries.map((entry, index): TableRow => ({
    key: `${entry.at}-${entry.job}-${index}`,
    at: entry.at,
    job: entry.job,
    name: jobName(entry.job, entry.name),
    message: entry.message,
  }));

export interface ActivityPage {
  /** Reads them now, and again every 10 seconds until `stop`. */
  readonly start: () => void;
  readonly stop: () => void;
}

/** The Activity page, wired to its parts. */
export const activityPage = (): ActivityPage => {
  const notice = find("gw-alert", "activity-notice");
  const usageGrid = find("gw-grid", "activity-usage");
  const jobsPlace = find("gw-stack", "activity-jobs");
  const jobs = jobsTable();
  const errors = errorsTable();
  const copied = copiedTable();

  jobsPlace?.replaceChildren(jobs.table, errors.table, copied.table);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let open = false;

  /** Counts each open and close, so only the latest open's reads go on. */
  let opened = 0;

  const show = async () => {
    try {
      const [jobList, usage, log] = await Promise.all([
        call((api) => api.activity.jobs()),
        call((api) => api.activity.usage()),
        call((api) =>
          api.activity.log({ query: { level: "error", limit: 500 } }),
        ),
      ]);

      if (notice !== null) {
        notice.hidden = false;
        notice.setAttribute(
          "tone",
          usage.holdUp === undefined ? "info" : "warning",
        );
        notice.textContent =
          usage.holdUp === undefined
            ? `Background work can run. Copies read up to ${usage.limits.copyRate} MB a second.`
            : `Background work is waiting: ${usage.holdUp}.`;
      }

      usageGrid?.replaceChildren(
        serverCard(usage),
        machineCard(usage),
        diskCard(usage),
      );
      jobs.setRows(jobList.map(jobRow));
      errors.setRows(errorRows(log));
      copied.setRows(copiedRows(jobList));
    } catch (error) {
      if (notice !== null) {
        notice.hidden = false;
        notice.setAttribute("tone", "danger");
        notice.textContent = `Activity can't be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  };

  const tick = async (round: number) => {
    await show();

    if (round === opened) timer = setTimeout(() => void tick(round), every);
  };

  return {
    start: () => {
      if (open) return;

      open = true;
      opened += 1;
      void tick(opened);
    },
    stop: () => {
      open = false;
      // A read still under way doesn't start another
      opened += 1;
      clearTimeout(timer);
    },
  };
};
