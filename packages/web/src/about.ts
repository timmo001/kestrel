/**
 * The About card at the end of Settings: this page's version and when it
 * was built, the server it's talking to and the version that runs, and a
 * link to the release's notes.
 */
import { version } from "@timmo001/kestrel-core";
import type { Fact } from "@timmo001/groundwork-ui";
import { call } from "./api.ts";
import { phBookOpen } from "./icons.ts";
import { dateTimeFormat, find } from "./shared.ts";

export interface AboutPanel {
  /** Asks the server who it is, and shows it beside this page's version. */
  readonly start: () => Promise<void>;
}

/** When the page was built, set by the build; a page that wasn't built has none. */
const built = process.env.KESTREL_BUILT;

const releaseNotes = `https://github.com/timmo001/kestrel/releases/tag/${version}`;

export const aboutPanel = (): AboutPanel => {
  const facts = find("gw-facts", "about-facts");
  const notes = find("gw-button", "about-notes");

  notes?.setAttribute("icon", phBookOpen);
  notes?.addEventListener("click", () => {
    window.open(releaseNotes, "_blank", "noopener");
  });

  const page: ReadonlyArray<Fact> = [
    { label: "Version", value: version },
    ...(built === undefined
      ? []
      : [{ label: "Built", value: dateTimeFormat.format(new Date(built)) }]),
  ];

  const start = async () => {
    const server = await call((api) => api.devices.server()).catch(
      () => undefined,
    );

    if (facts === null) return;

    facts.items = [
      ...page,
      ...(server === undefined
        ? [{ label: "Server", value: "Can't be reached" }]
        : [
            { label: "Server", value: server.name },
            {
              label: "Server version",
              value:
                server.version === version
                  ? server.version
                  : `${server.version}, not this page's ${version}`,
            },
            { label: "Server id", value: server.id },
          ]),
    ];
    facts.loading = false;
  };

  return { start };
};
