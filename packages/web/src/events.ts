/**
 * The Events page: events as each source reports them, newest first and
 * added as they arrive, and today's motion and PIR clips found by search,
 * which show events even if reports don't come through.
 */
import {
  cameraParts,
  type Camera,
  type CameraEvent,
} from "@timmo001/kestrel-core";
import type { TableRow } from "@timmo001/groundwork-ui";
import { call, listenForEvents } from "./api.ts";
import { cameraLabel } from "./cameras.ts";
import type { Clip } from "./recording-player.ts";
import {
  actionsColumn,
  find,
  reasonChips,
  recordingRow,
  timeFormat,
} from "./shared.ts";

export interface EventsOptions {
  /** Plays a clip on the Recordings page. */
  readonly onPlay: (clip: Clip) => void;
}

export interface EventsPage {
  /** Lists the events and listens for more, and today's clips from `cameras`. */
  readonly start: (
    cameras: ReadonlyArray<Camera>,
    today: string,
  ) => Promise<void>;
}

const eventRow = (event: CameraEvent): TableRow => ({
  receivedAt: event.receivedAt,
  kind: event.kind,
  camera: event.camera === null ? "" : cameraLabel(event.camera),
  state: event.active === null ? "" : event.active ? "Started" : "Ended",
});

/** The Events page, wired to its tables. */
export const eventsPage = (options: EventsOptions): EventsPage => {
  const eventsTable = find("gw-table", "events");
  const clipsTable = find("gw-table", "clips");

  if (eventsTable !== null) {
    eventsTable.columns = [
      {
        id: "receivedAt",
        header: "Received",
        cell: (row) => timeFormat.format(new Date(String(row.receivedAt))),
      },
      { id: "kind", header: "What" },
      { id: "camera", header: "Camera" },
      { id: "state", header: "State" },
    ];
  }

  if (clipsTable !== null) {
    clipsTable.columns = [
      // Plays it on the Recordings page, on its own day and camera
      actionsColumn(options.onPlay),
      { id: "begin", header: "Start" },
      { id: "cameraLabel", header: "Camera" },
      { id: "length", header: "Length", sortable: false },
      { id: "reasons", header: "Why", cell: reasonChips, wide: true },
    ];
  }

  const showEvents = async () => {
    const recent = await call((api) => api.events.recent());

    if (eventsTable !== null) eventsTable.rows = recent.map(eventRow);

    listenForEvents((event) => {
      if (eventsTable !== null) {
        eventsTable.rows = [eventRow(event), ...eventsTable.rows];
      }
    });
  };

  const showClips = async (cameras: ReadonlyArray<Camera>, today: string) => {
    const perCamera = await Promise.all(
      cameras.map((camera) =>
        call((api) =>
          api.cameras.recordings({
            params: cameraParts(camera.id),
            query: { date: today },
          }),
        ).catch(() => []),
      ),
    );

    if (clipsTable === null) return;

    clipsTable.rows = perCamera
      .flat()
      .filter((clip) =>
        clip.reasons.some((reason) => reason === "motion" || reason === "PIR"),
      )
      .map(recordingRow);
  };

  return {
    start: async (cameras, today) => {
      await Promise.all([showEvents(), showClips(cameras, today)]);
    },
  };
};
