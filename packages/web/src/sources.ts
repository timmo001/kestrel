/**
 * The Sources page: a section for each source, with whether it's
 * connected and, where it has details, its facts and clock, its storage
 * with any note about it, and each camera's state now, such as a
 * recorder's device, disks and channels.
 */
import type { Attention, Details, SourceInfo } from "@timmo001/kestrel-core";
import type { TableRow } from "@timmo001/groundwork-ui";
import { call } from "./api.ts";
import { cameraLabel } from "./cameras.ts";
import { dateTimeFormat, element, find, localDate } from "./shared.ts";

/** A passive note about storage, such as a full disk, which shows in the Storage card. */
export const isStorageNote = (item: Attention) =>
  item.level === "passive" && item.kind === "storage";

export const attentionAlert = (item: Attention) => {
  const alert = element("gw-alert", item.message);

  alert.setAttribute("tone", item.level === "alert" ? "warning" : "info");

  return alert;
};

const yesNo = (value: boolean | null) =>
  value === null ? "Unknown" : value ? "Yes" : "No";

const cameraRow = (state: Details["cameras"][number]): TableRow => ({
  camera: state.camera,
  label: cameraLabel(state.camera),
  signal: state.signal === null ? "Unknown" : state.signal ? "OK" : "No signal",
  recording: state.recording,
  motion: yesNo(state.motion),
});

/** A source's facts, with its clock where it keeps one. */
const factsCard = (details: Details) => {
  const card = element("gw-card");
  const facts = element("gw-facts");

  facts.items = [
    ...details.facts,
    ...(details.clock === null
      ? []
      : [
          {
            label: "Clock",
            value: dateTimeFormat.format(localDate(details.clock)),
          },
        ]),
  ];

  card.setAttribute("heading", "Device");
  card.append(facts);

  return card;
};

/** A source's storage, with the passive notes about it. */
const storageCard = (details: Details, notes: ReadonlyArray<Attention>) => {
  const card = element("gw-card");
  const row = element("gw-row");

  for (const each of details.storage) {
    const badge = element("gw-badge", each.state);

    badge.setAttribute("label", each.name);
    badge.setAttribute("tone", each.ok ? "success" : "warning");
    row.append(badge);
  }

  if (details.storage.length === 0) row.append(element("span", "No storage"));

  card.setAttribute("heading", "Storage");
  card.append(row, ...notes.map(attentionAlert));

  return card;
};

const camerasTable = (details: Details) => {
  const table = element("gw-table");

  table.setAttribute("label", "Cameras");
  table.setAttribute("row-key", "camera");
  table.setAttribute("search", "never");
  table.columns = [
    { id: "label", header: "Camera" },
    { id: "signal", header: "Signal" },
    { id: "recording", header: "Recording" },
    { id: "motion", header: "Motion now" },
  ];
  table.rows = details.cameras.map(cameraRow);

  return table;
};

/** One source's section. */
const sourceSection = (
  source: SourceInfo,
  details: Details | null,
  attention: ReadonlyArray<Attention>,
) => {
  const section = element("gw-stack");
  const parts: Array<HTMLElement> = [element("h3", source.name)];

  if (!source.connection.connected) {
    const alert = element(
      "gw-alert",
      `Can't reach ${source.name}${source.connection.error === null ? "" : `: ${source.connection.error}`}`,
    );

    alert.setAttribute("tone", "warning");
    parts.push(alert);
  }

  if (details !== null) {
    const grid = element("gw-grid");

    grid.style.setProperty("--gw-grid-min", "20rem");
    grid.append(
      factsCard(details),
      storageCard(
        details,
        attention.filter(
          (item) => item.source === source.id && isStorageNote(item),
        ),
      ),
    );
    parts.push(grid, camerasTable(details));
  }

  section.className = "source";
  section.append(...parts);

  return section;
};

export interface SourcesPage {
  /**
   * Shows each source, fetching the details of those that have them, and
   * returns the first source's clock, for the day to start Recordings on.
   */
  readonly show: (
    sources: ReadonlyArray<SourceInfo>,
    attention: ReadonlyArray<Attention>,
  ) => Promise<string | null>;
}

/** The Sources page, wired to its list. */
export const sourcesPage = (): SourcesPage => {
  const list = find("gw-stack", "source-list");

  return {
    show: async (sources, attention) => {
      const details = await Promise.all(
        sources.map((source) =>
          source.details && source.connection.connected
            ? call((api) =>
                api.sources.details({ params: { source: source.id } }),
              ).catch(() => null)
            : Promise.resolve(null),
        ),
      );

      list?.replaceChildren(
        ...sources.map((source, index) =>
          sourceSection(source, details[index] ?? null, attention),
        ),
      );

      return details.find((each) => each?.clock != null)?.clock ?? null;
    },
  };
};
