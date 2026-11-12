/**
 * The recorder as the server sees it, whichever source provides it: its
 * connection, what it reports, its recordings and alarm reports, and the
 * live streams go2rtc plays. A source package, such as the Raysharp one,
 * provides the layer.
 *
 * @module
 */
import { Context, type Effect, type Redacted, type Stream } from "effect";
import type {
  Connection,
  DeviceInfo,
  LiveStream,
  LocalTime,
  NoRecordings,
  ReceivedEvent,
  RecordedDay,
  RecorderStatus,
  Recording,
  RecorderUnavailable,
} from "./Domain.ts";

/** One frame of recorded H.264 video. */
export interface RecordedFrame {
  /** A key frame, which starts with its SPS, PPS and SEI. */
  readonly key: boolean;
  /**
   * When it was recorded, in microseconds since 1970, on the recorder's own
   * clock: local time with no zone, so read it as if it were UTC.
   */
  readonly time: number;
  readonly width: number;
  readonly height: number;
  /** The frame rate the stream was recorded at. */
  readonly fps: number;
  /** The frame in Annex B form, with start codes. */
  readonly data: Uint8Array;
}

/**
 * A live stream with the addresses go2rtc reads its main and sub stream
 * from. The addresses can hold a login, so they stay redacted.
 */
export interface LiveFeed {
  readonly stream: LiveStream;
  readonly main: Redacted.Redacted;
  readonly sub: Redacted.Redacted;
}

export class Recorder extends Context.Service<
  Recorder,
  {
    readonly connection: Effect.Effect<Connection>;
    readonly device: Effect.Effect<DeviceInfo, RecorderUnavailable>;
    readonly status: Effect.Effect<RecorderStatus, RecorderUnavailable>;
    /** Recordings on one channel (from 1) on one day, such as `2026-11-11`. */
    readonly recordings: (
      channel: number,
      date: string,
    ) => Effect.Effect<Array<Recording>, RecorderUnavailable>;
    /** Days with recordings on any channel in a month, such as `2026-11`. */
    readonly recordedDays: (
      month: string,
    ) => Effect.Effect<Array<RecordedDay>, RecorderUnavailable>;
    /**
     * What a channel (from 1) recorded between two recorder times, as its
     * frames, downloaded one file at a time; or with `every`, key frames
     * only, one per that many seconds. Fails up front when nothing was
     * recorded then.
     */
    readonly recorded: (options: {
      readonly channel: number;
      readonly begin: LocalTime;
      readonly end: LocalTime;
      readonly stream: "main" | "sub";
      readonly every?: number | undefined;
    }) => Effect.Effect<
      Stream.Stream<RecordedFrame, RecorderUnavailable>,
      RecorderUnavailable | NoRecordings
    >;
    /** The newest alarm reports, newest first. */
    readonly recentEvents: Effect.Effect<ReadonlyArray<ReceivedEvent>>;
    /** Alarm reports as they arrive. */
    readonly events: Stream.Stream<ReceivedEvent>;
    /**
     * Each channel's live streams and where go2rtc reads them from. Fails
     * until the source knows its channels, such as before its first login.
     */
    readonly live: Effect.Effect<ReadonlyArray<LiveFeed>, RecorderUnavailable>;
  }
>()("@timmo001/kestrel-core/Recorder") {}
