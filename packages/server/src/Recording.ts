/**
 * The cameras the server records itself, from the recording settings. Each
 * picked camera's main stream is read from go2rtc on this machine as MP4,
 * which go2rtc already has open, so the camera serves one connection
 * however many watch or record it, and no login reaches ffmpeg's command
 * line. MP4 rather than go2rtc's RTSP, which some cameras' streams come
 * through with their timestamps out of order. Files go in `recordings` in the state folder, or the folder you
 * chose, and each hour recordings past their hours, or past the disk share,
 * are cleared out, including those synced from sources. Clearing out waits
 * up to 10 minutes while Kestrel or the machine is past its limits; recording
 * never waits. Each camera and the clear-out report how they're getting on
 * as jobs.
 * A save that changes what's recorded starts the recordings again.
 *
 * @module
 */
import { hoursText } from "@timmo001/kestrel-core";
import * as Nvr from "@timmo001/kestrel-nvr";
import {
  Clock,
  Config,
  Duration,
  Effect,
  Layer,
  Schedule,
  Stream,
} from "effect";
import type { Job } from "./Api.ts";
import { ownRecordingsFolder } from "./Folders.ts";
import { Go2rtc, mainStream } from "./go2rtc/Go2rtc.ts";
import { basePath } from "./go2rtc/Proxy.ts";
import { Jobs } from "./Jobs.ts";
import { Sources } from "./Sources.ts";
import { Usage } from "./Usage.ts";

/** How long each recorded file runs. */
const segment = Duration.minutes(5);

/** How often old recordings are cleared out. */
const pruneEvery = Duration.hours(1);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sources = yield* Sources;
    const go2rtc = yield* Go2rtc;
    const jobs = yield* Jobs;
    const usage = yield* Usage;

    const ffmpeg = yield* Config.String("KESTREL_FFMPEG").pipe(
      Config.withDefault("ffmpeg"),
    );

    const ownFolder = yield* ownRecordingsFolder;

    const at = Clock.currentTimeMillis.pipe(
      Effect.map((now) => new Date(now).toISOString()),
    );

    const clearOut: Job = {
      id: "clear-out",
      kind: "clear-out",
      name: "Clear out old recordings",
      state: "idle",
      detail: "Runs every hour",
      since: "",
    };

    const reportClearOut = (change: (job: Job) => Job) =>
      jobs.update(clearOut.id, (job) => change(job ?? clearOut));

    const recordJob = (camera: string): Job => ({
      id: `record:${camera}`,
      kind: "record",
      name: `Record ${camera}`,
      state: "waiting",
      detail: "Starting",
      since: "",
    });

    const reportRecording = (camera: string) => (event: Nvr.RecorderEvent) =>
      Effect.gen(function* () {
        const now = yield* at;

        yield* jobs.update(`record:${camera}`, (was) => {
          const job = was ?? recordJob(camera);

          switch (event.kind) {
            case "started":
              return { ...job, state: "running", detail: "Recording" };
            case "error":
              return { ...job, lastError: { at: now, message: event.message } };
            case "stopped":
              return {
                ...job,
                state: "failed",
                detail: "Starting again shortly",
                lastError: { at: now, message: event.message },
              };
          }
        });
      });

    yield* reportClearOut((job) => job);

    yield* sources.recording.pipe(
      Stream.switchMap((settings) => {
        const folder = settings.folder ?? ownFolder;

        const pruning = Effect.gen(function* () {
          // Clearing out reads every file, but frees the disk, so it waits a while at most
          yield* usage
            .whenRoom((reason) =>
              reportClearOut((job) => ({
                ...job,
                state: "waiting",
                detail: `Waiting: ${reason}`,
              })),
            )
            .pipe(Effect.timeoutOption(Duration.minutes(10)));

          yield* reportClearOut((job) => ({
            ...job,
            state: "running",
            detail: "Clearing out",
          }));

          const cleared = yield* Nvr.prune({
            folder,
            continuousHours: settings.continuousHours,
            clipHours: settings.clipHours,
            diskShare: settings.diskShare,
          });

          const summary =
            cleared.expired + cleared.forSpace === 0
              ? "Nothing to clear out"
              : `Cleared out ${cleared.expired} old recordings and ${cleared.forSpace} for space, ${(cleared.bytes / 1e9).toFixed(1)} GB`;

          if (cleared.expired + cleared.forSpace > 0) {
            yield* Effect.logInfo(summary);
          }

          const now = yield* at;

          yield* reportClearOut((job) => ({
            ...job,
            state: "idle",
            detail: "Runs again in an hour",
            lastRun: { at: now, summary },
          }));
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const message = `Old recordings couldn't be cleared out: ${String(error)}`;
              const now = yield* at;

              yield* Effect.logWarning(message);
              yield* reportClearOut((job) => ({
                ...job,
                state: "failed",
                detail: "Tries again in an hour",
                lastError: { at: now, message },
              }));
            }),
          ),
          Effect.repeat(Schedule.spaced(pruneEvery)),
        );

        const recording = Effect.forEach(
          settings.cameras,
          (camera) =>
            Nvr.record({
              ffmpeg,
              folder,
              key: camera,
              input: `http://127.0.0.1:${go2rtc.port}${basePath}/api/stream.mp4?src=${mainStream(camera)}`,
              segment,
              report: reportRecording(camera),
            }).pipe(
              Effect.catch((error) =>
                reportRecording(camera)({
                  kind: "stopped",
                  message: `Recording ${camera} can't start: ${String(error)}`,
                }).pipe(
                  Effect.andThen(
                    Effect.logWarning(
                      `Recording ${camera} can't start: ${String(error)}`,
                    ),
                  ),
                ),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );

        // Cameras no longer recorded leave the list
        const tidy = Effect.gen(function* () {
          const kept = new Set(
            settings.cameras.map((camera) => `record:${camera}`),
          );

          yield* Effect.forEach(
            (yield* jobs.list).filter(
              (job) => job.kind === "record" && !kept.has(job.id),
            ),
            (job) => jobs.remove(job.id),
            { discard: true },
          );
        });

        return Stream.fromEffect(
          tidy.pipe(
            Effect.andThen(
              Effect.logInfo(
                settings.cameras.length === 0
                  ? "Recording no cameras"
                  : `Recording ${settings.cameras.length} cameras to ${folder}, keeping ${hoursText(settings.continuousHours)} continuous and ${hoursText(settings.clipHours)} of clips, in up to ${settings.diskShare}% of the disk`,
              ),
            ),
            Effect.andThen(
              Effect.all([pruning, recording], {
                concurrency: "unbounded",
                discard: true,
              }),
            ),
          ),
        );
      }),
      Stream.runDrain,
      Effect.forkScoped,
    );
  }),
);
