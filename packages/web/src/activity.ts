/**
 * The Activity page: what the server does by itself and how much of the
 * machine it uses. Each job, such as copying recordings from sources,
 * recording a camera or clearing out old recordings, with what it's doing,
 * how far through it is and its last error; the recordings copied most
 * lately and what each camera's recordings take on disk; and the server's
 * memory and CPU against the limits background work keeps to, with the
 * machine's and the last hour of each. It reads them again every 10 seconds
 * while it's open.
 */
import type { TableRow } from "@timmo001/groundwork-ui";
import {
  JobState,
  type Job,
  type UsageReport,
  type UsageSample,
} from "@timmo001/kestrel-server/api";
import { Schema } from "effect";
import { call } from "./api.ts";
import { cameraLabel } from "./cameras.ts";
import { dateTimeFormat, element, find, timeFormat } from "./shared.ts";

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
 * A small line graph of the last hour, as an SVG drawn in the accent
 * colour, scaled from 0 to `top`, or the highest value where that's higher.
 */
const graph = (
  label: string,
  samples: ReadonlyArray<UsageSample>,
  value: (sample: UsageSample) => number,
  top: number,
) => {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const line = document.createElementNS(namespace, "polyline");
  const width = 300;
  const height = 48;
  const values = samples.map(value);
  const highest = Math.max(top, ...values, 1);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${label} over the last hour`);
  svg.classList.add("usage-graph");
  line.setAttribute(
    "points",
    values
      .map(
        (each, index) =>
          `${((index / Math.max(values.length - 1, 1)) * width).toFixed(1)},${(height - (each / highest) * height).toFixed(1)}`,
      )
      .join(" "),
  );
  svg.append(line);

  return svg;
};

/** A meter, with the last hour's graph under it. */
const usageMeter = (options: {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly high?: number;
  readonly display: string;
  readonly caption: string;
  readonly history: ReadonlyArray<UsageSample>;
  readonly of: (sample: UsageSample) => number;
}) => {
  const wrap = element("div");
  const meter = element("gw-meter");

  meter.label = options.label;
  meter.value = options.value;
  meter.max = options.max;
  meter.high = options.high;
  meter.display = options.display;
  meter.caption = options.caption;
  wrap.className = "usage-meter";
  wrap.append(meter);

  if (options.history.length > 1) {
    wrap.append(graph(options.label, options.history, options.of, options.max));
  }

  return wrap;
};

const card = (heading: string, ...content: ReadonlyArray<Node>) => {
  const created = element("gw-card");

  created.setAttribute("heading", heading);
  created.append(...content);

  return created;
};

/** The server's memory and CPU, against its limits. */
const serverCard = (usage: UsageReport) => {
  const { now, limits, history } = usage;
  const cores = Math.max(now.cores, 1);
  const cpu = now.kestrelCpu / cores;

  return card(
    "Server",
    usageMeter({
      label: "Memory",
      value: now.kestrelMemory / megabyte,
      max: limits.memoryLimit,
      high: limits.memoryLimit * 0.8,
      display: `${bytesText(now.kestrelMemory)} of ${limits.memoryLimit} MB`,
      caption: "The server, go2rtc and ffmpeg",
      history,
      of: (sample) => sample.kestrelMemory / megabyte,
    }),
    usageMeter({
      label: "CPU",
      value: cpu,
      max: limits.cpuShare,
      high: limits.cpuShare * 0.8,
      display: `${Math.round(cpu)}% of ${limits.cpuShare}%`,
      caption: `Of all ${cores} cores`,
      history,
      of: (sample) => sample.kestrelCpu / Math.max(sample.cores, 1),
    }),
  );
};

/** The machine's memory and load. */
const machineCard = (usage: UsageReport) => {
  const { now, limits, history } = usage;
  const used = now.memory - now.memoryFree;
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
      high: 100 - limits.memoryFree,
      display: `${bytesText(used)} of ${bytesText(now.memory)}`,
      caption: `${bytesText(now.memoryFree)} free; background work waits under ${limits.memoryFree}%`,
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

  meter.label = "Disk in use";
  meter.value = (used / Math.max(disk.total, 1)) * 100;
  meter.high = 85;
  meter.critical = 95;
  meter.display = `${bytesText(used)} of ${bytesText(disk.total)}`;
  meter.caption = `Recordings take ${bytesText(disk.recordings)}${disk.counted === undefined ? "" : `, counted ${timeFormat.format(new Date(disk.counted))}`}`;

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

  return card("Recordings", meter, table);
};

const jobRow = (job: Job): TableRow => ({
  id: job.id,
  name:
    job.kind === "record"
      ? `Record ${cameraLabel(job.id.slice("record:".length))}`
      : job.name,
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

const jobsTable = (jobs: ReadonlyArray<Job>) => {
  const table = element("gw-table");

  table.setAttribute("label", "Jobs");
  table.setAttribute("row-key", "id");
  table.setAttribute("search", "never");
  table.setAttribute("empty-label", "No jobs yet");
  table.columns = [
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
    { id: "detail", header: "Doing" },
    { id: "since", header: "Since" },
    { id: "progress", header: "This pass" },
    { id: "lastRun", header: "Last run" },
    { id: "lastError", header: "Last error" },
  ];
  table.rows = jobs.map(jobRow);

  return table;
};

/** The copy job's newest recordings, newest first. */
const copiedTable = (jobs: ReadonlyArray<Job>) => {
  const recent = jobs.flatMap((job) => job.recent ?? []);
  const table = element("gw-table");

  table.setAttribute("label", "Copied lately");
  table.setAttribute("row-key", "key");
  table.setAttribute("search", "never");
  table.setAttribute("empty-label", "Nothing copied since the server started");
  table.columns = [
    { id: "label", header: "Camera" },
    { id: "begin", header: "Recording from" },
    {
      id: "bytes",
      header: "Size",
      numeric: true,
      cell: (row) => bytesText(Number(row.bytes)),
    },
    { id: "at", header: "Copied" },
  ];
  table.rows = recent.map((each): TableRow => ({
    key: `${each.camera}-${each.begin}`,
    label: cameraLabel(each.camera),
    begin: dateTimeFormat.format(new Date(each.begin)),
    bytes: each.bytes,
    at: when(each.at),
  }));

  return table;
};

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

  let timer: ReturnType<typeof setTimeout> | undefined;
  let open = false;

  /** Counts each open and close, so only the latest open's reads go on. */
  let opened = 0;

  const show = async () => {
    try {
      const [jobs, usage] = await Promise.all([
        call((api) => api.activity.jobs()),
        call((api) => api.activity.usage()),
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
      jobsPlace?.replaceChildren(jobsTable(jobs), copiedTable(jobs));
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
