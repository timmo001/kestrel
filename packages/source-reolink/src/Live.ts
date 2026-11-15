/**
 * A camera's live video over Reolink's own protocol on port 9000, for
 * recording: its RTSP stream has been seen to weave the sub stream's frames
 * into the main one, which its own protocol doesn't. It comes as an MPEG
 * transport stream from a key frame on, timed by the camera's own clock,
 * which go2rtc reads as it is.
 *
 * @module
 */
import { Media, Session } from "@timmo001/kestrel-protocol-baichuan";
import { SourceUnavailable } from "@timmo001/kestrel-core";
import { Effect, Redacted, Stream } from "effect";
import { clockRate, writer } from "./MpegTs.ts";

export interface OwnLiveOptions {
  readonly name: string;
  readonly host: string;
  readonly username: Redacted.Redacted;
  readonly password: Redacted.Redacted;
  readonly channel: number;
  /** Told when it starts sending video, with `null`, or why it stopped. */
  readonly report: (problem: string | null) => Effect.Effect<void>;
}

/** A channel's main stream, live, as a transport stream; each run logs in afresh. */
export const ownLive = (options: OwnLiveOptions) =>
  Stream.suspend(() => {
    const reading = Media.decoder();
    let write: ReturnType<typeof writer> | undefined;
    let last = 0;
    // From 10 seconds in, so the clock that runs behind it never goes below
    // 0, and go2rtc, which times each frame from the one before, doesn't hold
    // the first for that long
    let time = 10 * clockRate;

    return Session.connect({
      host: options.host,
      username: options.username,
      password: options.password,
    }).pipe(
      Effect.map((session) => session.live({ channel: options.channel })),
      Stream.unwrap,
      Stream.flatMap((piece) => Stream.fromIterable(reading.push(piece))),
      Stream.flatMap((frame) => {
        const codec = reading.codec();

        if (write === undefined) {
          if (!frame.key || (codec !== "H264" && codec !== "H265")) {
            return Stream.empty;
          }

          write = writer(codec);
          last = frame.microseconds;

          return Stream.fromEffect(
            options
              .report(null)
              .pipe(Effect.as(write({ key: true, time, data: frame.data }))),
          );
        }

        // Its counter wraps every 71 minutes, which the unsigned difference rides over
        time += Math.round(
          (((frame.microseconds - last) >>> 0) * clockRate) / 1e6,
        );
        last = frame.microseconds;

        return Stream.succeed(
          write({ key: frame.key, time, data: frame.data }),
        );
      }),
      Stream.tapError((error) => options.report(error.message)),
      Stream.mapError(
        (error) =>
          new SourceUnavailable({
            message: `${options.name} couldn't send video over its own protocol: ${error.message}`,
          }),
      ),
    );
  });
