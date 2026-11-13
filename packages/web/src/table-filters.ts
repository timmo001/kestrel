/**
 * A table with a quick search and filters, like Upkeep's runs: a Filters
 * button opens a sheet with one filter per column it narrows by, and each
 * filter in use shows beside it as a chip that clears it. A table with a
 * time column also gets a day to pick and the times of day between, such as
 * Today from 08:00 to 12:00. The table is made once and only its rows
 * change, so the search, sort and filters stay put as the page reads again,
 * and across visits under `key`.
 */
import {
  toDayString,
  type DatePreset,
  type FilterOption,
  type TableColumn,
  type TableRow,
} from "@timmo001/groundwork-ui";
import { Option, Schema } from "effect";
import { phFunnelSimple, phX } from "./icons.ts";
import { dayFormat, element } from "./shared.ts";

export interface RowFilter {
  readonly id: string;
  readonly label: string;
  /** What several of its values are, such as `cameras`. */
  readonly many: string;
  readonly icon?: string;
  /** The row's value for it, and that value's name. */
  readonly of: (row: TableRow) => {
    readonly value: string;
    readonly label: string;
  };
}

export interface FilteredTable {
  readonly table: HTMLElementTagNameMap["gw-table"];
  readonly setRows: (rows: ReadonlyArray<TableRow>) => void;
}

/** The filters' ticked values, by filter id, as kept in the browser's storage. */
const decodeChosen = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Array(Schema.String)),
  ),
);

const load = (key: string) =>
  new Map<string, ReadonlyArray<string>>(
    Object.entries(
      Option.getOrElse(
        decodeChosen(localStorage.getItem(key) ?? "{}"),
        () => ({}),
      ),
    ),
  );

/**
 * The date filter: a day as `YYYY-MM-DD`, and the times of day between as
 * `HH:MM`, each empty when it's not set.
 */
const When = Schema.Struct({
  day: Schema.String,
  from: Schema.String,
  to: Schema.String,
});

type When = typeof When.Type;

const anyTime = { day: "", from: "", to: "" } satisfies When;

const decodeWhen = Schema.decodeUnknownOption(Schema.fromJsonString(When));

const loadWhen = (key: string) =>
  Option.getOrElse(
    decodeWhen(localStorage.getItem(key) ?? ""),
    (): When => anyTime,
  );

const isTimed = (when: When) =>
  when.day !== "" || when.from !== "" || when.to !== "";

const timeOfDay = (date: Date) =>
  [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

/** Whether an ISO time falls on the day and between the times of day. */
const isWithin = (when: When, iso: string) => {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return false;

  if (when.day !== "" && toDayString(date) !== when.day) return false;

  const time = timeOfDay(date);
  const after = when.from === "" || time >= when.from;
  const before = when.to === "" || time <= when.to;

  // Times past midnight, such as 22:00 to 02:00, take in either side of it
  if (when.from !== "" && when.to !== "" && when.from > when.to) {
    return after || before;
  }

  return after && before;
};

const yesterday = () => {
  const date = new Date();

  date.setDate(date.getDate() - 1);

  return toDayString(date);
};

/** The date filter's chip: Today, Yesterday or the date, and the times. */
const whenLabel = (when: When) => {
  const parts: Array<string> = [];

  if (when.day === toDayString(new Date())) {
    parts.push("Today");
  } else if (when.day === yesterday()) {
    parts.push("Yesterday");
  } else if (when.day !== "") {
    parts.push(dayFormat.format(new Date(`${when.day}T00:00:00`)));
  }

  if (when.from !== "" && when.to !== "") {
    parts.push(`${when.from} to ${when.to}`);
  } else if (when.from !== "") {
    parts.push(`from ${when.from}`);
  } else if (when.to !== "") {
    parts.push(`until ${when.to}`);
  }

  const label = parts.join(", ");

  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
};

/** The days under the calendar, as nothing has happened tomorrow yet. */
const datePresets: ReadonlyArray<DatePreset> = [
  { label: "Yesterday", days: -1 },
  { label: "Today", days: 0 },
];

export const filteredTable = (options: {
  /** Keeps the search, sort and filters in the browser's storage. */
  readonly key: string;
  readonly label: string;
  readonly rowKey: string;
  /** What it says with no rows. */
  readonly empty: string;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly filters: ReadonlyArray<RowFilter>;
  /** The column it sorts by at first, newest or highest first. */
  readonly sort?: string;
  /** The column holding each row's ISO time, for the date filter. */
  readonly time?: string;
}): FilteredTable => {
  const filtersKey = `${options.key}-filters`;
  const whenKey = `${options.key}-when`;
  const chosen: Map<string, ReadonlyArray<string>> = load(filtersKey);
  const table = element("gw-table");
  const button = element("gw-button");
  const sheet = element("gw-sheet");
  const timeColumn = options.time;

  const timeOf = (row: TableRow) =>
    timeColumn === undefined ? "" : String(row[timeColumn]);

  let when = timeColumn === undefined ? anyTime : loadWhen(whenKey);
  let chips: ReadonlyArray<HTMLElement> = [];
  let rows: ReadonlyArray<TableRow> = [];

  table.setAttribute("label", options.label);
  table.setAttribute("row-key", options.rowKey);
  table.setAttribute("storage-key", options.key);
  // Always there, so it doesn't come and go as the filters narrow the rows
  table.setAttribute("search", "always");
  table.setAttribute("search-label", `Search ${options.label.toLowerCase()}`);
  table.columns = [...options.columns];

  // A long list scrolls in its own frame rather than running the page on
  if (options.sort !== undefined) {
    table.setAttribute("sort", options.sort);
    table.setAttribute("descending", "");
    table.setAttribute("contained", "");
  }

  button.slot = "toolbar";
  button.setAttribute("size", "small");
  button.setAttribute("icon", phFunnelSimple);
  button.addEventListener("click", () => sheet.toggle());

  sheet.slot = "toolbar";
  sheet.setAttribute("heading", "Filters");

  const save = () =>
    localStorage.setItem(
      filtersKey,
      JSON.stringify(Object.fromEntries(chosen)),
    );

  const choose = (id: string, values: ReadonlyArray<string>) => {
    if (values.length === 0) {
      chosen.delete(id);
    } else {
      chosen.set(id, values);
    }

    save();
    render();
  };

  const pickers = options.filters.map((filter) => {
    const picker = element("gw-filter");

    picker.setAttribute("label", filter.label);
    picker.setAttribute("search-label", `Search ${filter.many}`);

    if (filter.icon !== undefined) picker.setAttribute("icon", filter.icon);

    picker.addEventListener("change", () => choose(filter.id, picker.value));

    return { filter, picker };
  });

  sheet.append(...pickers.map(({ picker }) => picker));

  const day = element("gw-date-picker");
  const from = element("gw-input");
  const to = element("gw-input");

  const setWhen = (next: When) => {
    when = next;

    if (isTimed(when)) {
      localStorage.setItem(whenKey, JSON.stringify(when));
    } else {
      localStorage.removeItem(whenKey);
    }

    render();
  };

  if (timeColumn !== undefined) {
    const box = element("div");
    const times = element("div");

    day.setAttribute("label", "Day");
    day.setAttribute("placeholder", "Every day");
    day.setAttribute("unmarked", "dim");
    day.toggleAttribute("presets", true);
    day.presetOptions = datePresets;
    day.addEventListener("change", () => setWhen({ ...when, day: day.value }));

    from.setAttribute("label", "From");
    from.addEventListener("change", () =>
      setWhen({ ...when, from: from.value }),
    );
    to.setAttribute("label", "To");
    to.addEventListener("change", () => setWhen({ ...when, to: to.value }));

    for (const field of [from, to]) {
      field.setAttribute("type", "time");
      field.setAttribute("size", "small");
    }

    times.className = "table-times";
    times.append(from, to);
    box.className = "table-date";
    box.append(day, times);
    sheet.prepend(box);
  }

  const render = () => {
    for (const { filter, picker } of pickers) {
      const counts = new Map<string, { label: string; count: number }>();

      for (const row of rows) {
        const { value, label } = filter.of(row);
        const before = counts.get(value);

        counts.set(value, { label, count: (before?.count ?? 0) + 1 });
      }

      const ticked = chosen.get(filter.id) ?? [];

      // A ticked value with no rows yet still shows, so it can be unticked
      for (const value of ticked) {
        if (!counts.has(value)) counts.set(value, { label: value, count: 0 });
      }

      picker.options = [...counts]
        .map(([value, { label, count }]): FilterOption => ({
          value,
          label,
          count,
        }))
        .toSorted((a, b) => a.label.localeCompare(b.label));
      picker.value = [...ticked];
    }

    const timed = timeColumn !== undefined && isTimed(when);
    const count = chosen.size + (timed ? 1 : 0);

    if (timeColumn !== undefined) {
      // The days with rows stand out in the calendar
      day.marked = [
        ...new Set(
          rows.flatMap((row) => {
            const date = new Date(timeOf(row));

            return Number.isNaN(date.getTime()) ? [] : [toDayString(date)];
          }),
        ),
      ];
      day.max = toDayString(new Date());
      day.value = when.day;
      from.value = when.from;
      to.value = when.to;
    }

    table.setAttribute(
      "empty-label",
      count === 0 ? options.empty : "Nothing matches the filters",
    );
    table.rows = rows.filter(
      (row) =>
        (!timed || isWithin(when, timeOf(row))) &&
        options.filters.every((filter) => {
          const ticked = chosen.get(filter.id);

          return (
            ticked === undefined ||
            ticked.length === 0 ||
            ticked.includes(filter.of(row).value)
          );
        }),
    );

    button.textContent = count === 0 ? "Filters" : `Filters (${count})`;
    button.setAttribute("appearance", count === 0 ? "outlined" : "accent");
    button.setAttribute("variant", count === 0 ? "neutral" : "brand");

    for (const each of chips) each.remove();

    const chip = (name: string, clear: () => void) => {
      const created = element("gw-button", name);

      created.slot = "toolbar";
      created.setAttribute("size", "small");
      created.setAttribute("appearance", "outlined");
      created.setAttribute("variant", "neutral");
      created.setAttribute("icon", phX);
      created.setAttribute("label", `Remove ${name}`);
      created.addEventListener("click", clear);

      return created;
    };

    chips = [
      ...(timed ? [chip(whenLabel(when), () => setWhen(anyTime))] : []),
      ...options.filters.flatMap((filter) => {
        const ticked = chosen.get(filter.id);

        if (ticked === undefined) return [];

        const [only] = ticked;

        const name =
          ticked.length === 1 && only !== undefined
            ? (rows
                .map((row) => filter.of(row))
                .find((each) => each.value === only)?.label ?? only)
            : `${ticked.length} ${filter.many}`;

        return [chip(name, () => choose(filter.id, []))];
      }),
    ];

    button.after(...chips);
  };

  table.append(button, sheet);
  render();

  return {
    table,
    setRows: (next) => {
      rows = next;
      render();
    },
  };
};
