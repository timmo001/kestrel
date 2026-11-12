/**
 * What a source kind implements, such as the Raysharp recorder: its
 * connection and what needs you about it, its cameras and where go2rtc
 * reads their live streams, and the capabilities only some sources have,
 * each optional: recordings, events, still pictures and details. Cameras are named by their
 * full id, such as `swann/3`.
 *
 * @module
 */
import type { Effect, Redacted, Stream } from "effect";
import type { Attention, Details } from "./Details.ts";
import type {
  NoRecordings,
  SourceUnavailable,
  UnknownCamera,
} from "./Errors.ts";
import type { CameraEvent } from "./Events.ts";
import type { CameraId, SourceId } from "./Ids.ts";
import type { RecordedDay, Recording } from "./Recordings.ts";
import type { Connection } from "./Sources.ts";
import type { LocalTime } from "./Times.ts";

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

/** A camera as its source describes it; the server adds its stream names. */
export interface CameraInfo {
  readonly id: CameraId;
  readonly name: string;
  /** A recorder's channel number; `null` for a camera that isn't one. */
  readonly channel: number | null;
  /** Whether it has a picture now; `null` when the source can't tell. */
  readonly signal: boolean | null;
  readonly live: boolean;
  /** Whether it has a still picture of its own, for a camera with no video. */
  readonly still: boolean;
  readonly recordings: boolean;
  readonly events: boolean;
}

/** A camera's still picture, as its source sent it. */
export interface StillPicture {
  readonly data: Uint8Array;
  /** Its type, such as `image/jpeg`. */
  readonly contentType: string;
}

/** Still pictures, for a source with cameras that have them. */
export interface SourceStills {
  /** A camera's picture now. */
  readonly still: (
    camera: CameraId,
  ) => Effect.Effect<StillPicture, SourceUnavailable | UnknownCamera>;
}

/**
 * Where go2rtc reads a camera's live streams: the full one and, where it
 * has one, the small sub stream. They can hold a login, so they stay
 * redacted.
 */
export interface LiveFeed {
  readonly camera: CameraId;
  readonly main: Redacted.Redacted;
  readonly sub: Redacted.Redacted | null;
  /**
   * The width over height to draw the sub stream at, for one whose frames
   * squeeze the picture into another shape, such as a recorder's 16:9
   * picture in 352×288. Left out, it's drawn at its own shape.
   */
  readonly subRatio?: number;
}

/** Recordings, for a source that keeps them. */
export interface SourceRecordings {
  /** Days with recordings on any of its cameras in a month, such as `2026-11`. */
  readonly days: (
    month: string,
  ) => Effect.Effect<Array<RecordedDay>, SourceUnavailable>;
  /** A camera's recordings on one day, such as `2026-11-11`. */
  readonly list: (
    camera: CameraId,
    date: string,
  ) => Effect.Effect<Array<Recording>, SourceUnavailable | UnknownCamera>;
  /**
   * What a camera recorded between two times, as its frames; or with
   * `every`, key frames only, one per that many seconds. Fails up front
   * when nothing was recorded then.
   */
  readonly video: (options: {
    readonly camera: CameraId;
    readonly begin: LocalTime;
    readonly end: LocalTime;
    readonly stream: "main" | "sub";
    readonly every?: number | undefined;
  }) => Effect.Effect<
    Stream.Stream<RecordedFrame, SourceUnavailable>,
    SourceUnavailable | NoRecordings | UnknownCamera
  >;
}

/** Events, for a source that reports them. */
export interface SourceEvents {
  /** The newest, newest first. */
  readonly recent: Effect.Effect<ReadonlyArray<CameraEvent>>;
  /** Each as it arrives. */
  readonly live: Stream.Stream<CameraEvent>;
}

export interface Source {
  readonly id: SourceId;
  /** Which kind of source, such as `raysharp`. */
  readonly kind: string;
  readonly name: string;
  readonly connection: Effect.Effect<Connection>;
  /** What needs you about it now, such as a lost connection or a bad disk. */
  readonly attention: Effect.Effect<ReadonlyArray<Attention>>;
  /** Its cameras. Fails until it knows them, such as before a recorder's first login. */
  readonly cameras: Effect.Effect<ReadonlyArray<CameraInfo>, SourceUnavailable>;
  /** Where go2rtc reads each camera's live streams; fails as `cameras` does. */
  readonly live: Effect.Effect<ReadonlyArray<LiveFeed>, SourceUnavailable>;
  readonly recordings?: SourceRecordings;
  readonly events?: SourceEvents;
  readonly stills?: SourceStills;
  /** What it shows about itself, such as a recorder's device, disks and channels. */
  readonly details?: Effect.Effect<Details, SourceUnavailable>;
}
