/**
 * The cameras the server records itself, from the recording settings. Each
 * picked camera's main stream is read from go2rtc on this machine as MP4,
 * which go2rtc already has open, so the camera serves one connection
 * however many watch or record it, and no login reaches ffmpeg's command
 * line. MP4 rather than go2rtc's RTSP, which some cameras' streams come
 * through with their timestamps out of order. Files go in `recordings` in the state folder, or the folder you
 * chose, and each hour recordings past their hours, or past the disk share,
 * are cleared out, including those synced from sources.
 * A save that changes what's recorded starts the recordings again.
 *
 * @module
 */
import { hoursText } from "@timmo001/kestrel-core";
import * as Nvr from "@timmo001/kestrel-nvr";
import { Config, Duration, Effect, Layer, Schedule, Stream } from "effect";
import { ownRecordingsFolder } from "./Folders.ts";
import { Go2rtc, mainStream } from "./go2rtc/Go2rtc.ts";
import { basePath } from "./go2rtc/Proxy.ts";
import { Sources } from "./Sources.ts";

/** How long each recorded file runs. */
const segment = Duration.minutes(5);

/** How often old recordings are cleared out. */
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

        const pruning = Nvr.prune({
          folder,
          continuousHours: settings.continuousHours,
          clipHours: settings.clipHours,
          diskShare: settings.diskShare,
        }).pipe(
          Effect.tap((cleared) =>
            cleared.expired + cleared.forSpace === 0
              ? Effect.void
              : Effect.logInfo(
                  `Cleared out ${cleared.expired} old recordings and ${cleared.forSpace} for space, ${(cleared.bytes / 1e9).toFixed(1)} GB`,
                ),
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
              : `Recording ${settings.cameras.length} cameras to ${folder}, keeping ${hoursText(settings.continuousHours)} continuous and ${hoursText(settings.clipHours)} of clips, in up to ${settings.diskShare}% of the disk`,
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
