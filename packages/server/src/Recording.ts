/**
 * The cameras the server records itself, from the recording settings. Each
 * picked camera's main stream is read from go2rtc on this machine as MP4,
 * which go2rtc already has open, so the camera serves one connection
 * however many watch or record it, and no login reaches ffmpeg's command
 * line. MP4 rather than go2rtc's RTSP, which some cameras' streams come
 * through with their timestamps out of order. Files go in `recordings` in the state folder, or the folder you
 * chose, and each hour the days older than the ones kept are cleared out.
 * A save that changes what's recorded starts the recordings again.
 *
 * @module
 */
import * as Nvr from "@timmo001/kestrel-nvr";
import { Config, Duration, Effect, Layer, Schedule, Stream } from "effect";
import { ownRecordingsFolder } from "./Folders.ts";
import { Go2rtc, mainStream } from "./go2rtc/Go2rtc.ts";
import { basePath } from "./go2rtc/Proxy.ts";
import { Sources } from "./Sources.ts";

/** How long each recorded file runs. */
const segment = Duration.minutes(5);

/** How often old days are cleared out. */
const pruneEvery = Duration.hours(1);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sources = yield* Sources;
    const go2rtc = yield* Go2rtc;

    const ffmpeg = yield* Config.String("KESTREL_FFMPEG").pipe(
      Config.withDefault("ffmpeg"),
    );

    const ownFolder = yield* ownRecordingsFolder;

    yield* sources.recording.pipe(
      Stream.switchMap((settings) => {
        const folder = settings.folder ?? ownFolder;

        const pruning = Nvr.prune({ folder, days: settings.days }).pipe(
          Effect.tap((removed) =>
            removed === 0
              ? Effect.void
              : Effect.logInfo(`Cleared out ${removed} days of recordings`),
          ),
          Effect.catch((error) =>
            Effect.logWarning(
              `Old recordings couldn't be cleared out: ${String(error)}`,
            ),
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
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `Recording ${camera} can't start: ${String(error)}`,
                ),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );

        return Stream.fromEffect(
          Effect.logInfo(
            settings.cameras.length === 0
              ? "Recording no cameras"
              : `Recording ${settings.cameras.length} cameras to ${folder}, keeping ${settings.days} days`,
          ).pipe(
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
