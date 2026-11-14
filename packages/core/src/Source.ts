/**
 * What a source kind implements, such as the Raysharp recorder: its
 * connection and what needs you about it, its cameras and where go2rtc
 * reads their live streams, and the capabilities only some sources have,
 * each optional: recordings, events, still pictures, moving and zooming,
 * picture settings, sending clips to Kestrel and details. Cameras are named by their
 * full id, such as `swann/3`.
 *
 * @module
 */
import type { Effect, Redacted, Stream } from "effect";
import type {
  PictureCommand,
  PictureControls,
  PictureState,
  PtzCommand,
  PtzControls,
  PtzState,
} from "./Controls.ts";
import type { Attention, Details } from "./Details.ts";
import type {
  NoRecordings,
  NotSupported,
  SourceUnavailable,
  UnknownCamera,
} from "./Errors.ts";
import type { CameraEvent } from "./Events.ts";
import type { CameraId, SourceId } from "./Ids.ts";
import type { RecordedDay, Recording } from "./Recordings.ts";
import type { Connection } from "./Sources.ts";
import type { LocalTime } from "./Times.ts";
import type { UploadCheck } from "./Uploads.ts";

/** One frame of recorded H.264 or H.265 video. */
export interface RecordedFrame {
  /** A key frame, which starts with its parameter sets (VPS for H.265, SPS, PPS) and SEI. */
  readonly key: boolean;
  /** H.265 when `"h265"`; H.264 when left out, as most sources send. */
  readonly codec?: "h264" | "h265" | undefined;
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
  /** How it moves and zooms, for a camera that does; left out for one that doesn't. */
  readonly ptz?: PtzControls;
  /** Which picture settings it lets you change, for a camera that does. */
  readonly picture?: PictureControls;
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
  /**
   * Whether its streams carry the camera's sound. Left out, they're played
   * without it, since some offer a sound track that never sends anything.
   */
  readonly sound?: boolean;
  /**
   * Whether its streams take seconds to start, as one looked up afresh each
   * time does, such as on a web page. Left out, they start at once.
   */
  readonly slowStart?: boolean;
  /**
   * For a camera with other pictures, such as a second lens: the main
   * picture's name and whether the lens zoom changes it.
   */
  readonly view?: { readonly name: string; readonly zoom: boolean };
  /** Its other pictures, where it has them. */
  readonly others?: ReadonlyArray<LiveView>;
}

/** Another of a camera's pictures, such as its telephoto lens. */
export interface LiveView {
  /** Its key, such as `telephoto`, which names its go2rtc streams. */
  readonly key: string;
  readonly name: string;
  readonly main: Redacted.Redacted;
  readonly sub: Redacted.Redacted | null;
  /** Whether the camera's lens zoom changes this picture. */
  readonly zoom: boolean;
}

/** Moving and zooming, for a source with cameras that do; a camera that doesn't is `NotSupported`. */
export interface SourcePtz {
  /** Where a camera's lens is zoomed and its presets. */
  readonly state: (
    camera: CameraId,
  ) => Effect.Effect<
    PtzState,
    SourceUnavailable | UnknownCamera | NotSupported
  >;
  /**
   * Tells a camera to move, stop, zoom or go to a preset. A camera told to
   * move stops by itself unless told again within a second or so.
   */
  readonly send: (
    camera: CameraId,
    command: PtzCommand,
  ) => Effect.Effect<void, SourceUnavailable | UnknownCamera | NotSupported>;
}

/**
 * Picture settings, such as hue and brightness, for a source with cameras
 * that have them; a camera that doesn't is `NotSupported`.
 */
export interface SourcePicture {
  readonly state: (
    camera: CameraId,
  ) => Effect.Effect<
    PictureState,
    SourceUnavailable | UnknownCamera | NotSupported
  >;
  /** Changes a camera's picture, then says what it's set to now. */
  readonly send: (
    camera: CameraId,
    command: PictureCommand,
  ) => Effect.Effect<
    PictureState,
    SourceUnavailable | UnknownCamera | NotSupported
  >;
}

/** How background work, such as copying, keeps to the limits. */
export interface Pace {
  /** The most bytes a second to read. */
  readonly bytesPerSecond: number;
  /** Waits while background work should. */
  readonly room: Effect.Effect<unknown>;
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
   * when nothing was recorded then. Left out where the source lists its
   * recordings but can't hand them over, so they're never copied.
   */
  readonly video?: (options: {
    readonly camera: CameraId;
    readonly begin: LocalTime;
    readonly end: LocalTime;
    readonly stream: "main" | "sub";
    readonly every?: number | undefined;
    /**
     * For background work: a source that does heavy work of its own before
     * its frames come, such as replaying or converting a file, keeps to it.
     * One whose frames come as they're read is held back by its reader.
     */
    readonly pace?: Pace | undefined;
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

/** Kestrel's own FTP receiver, and the login it made for a source. */
export interface UploadTarget {
  readonly port: number;
  readonly user: string;
  readonly password: Redacted.Redacted;
}

/** A clip a camera sent, as its source reads its name. */
export interface UploadedClip {
  readonly camera: CameraId;
  readonly begin: LocalTime;
}

/** Sending clips to Kestrel, for a source with cameras that send them by FTP, such as when they see motion. */
export interface SourceUploads {
  /** Whether its cameras send their clips to Kestrel with this login now. */
  readonly sending: (
    target: UploadTarget,
  ) => Effect.Effect<boolean, SourceUnavailable>;
  /**
   * Points its cameras at Kestrel, or with `null` stops them sending, and
   * says how it went, with the camera's own test where it has one.
   */
  readonly send: (
    target: UploadTarget | null,
  ) => Effect.Effect<UploadCheck, SourceUnavailable>;
  /**
   * Which camera a file it sent is from and when it starts, from its path;
   * `null` for one that isn't a clip, such as a picture or a test file.
   */
  readonly clip: (
    path: string,
  ) => Effect.Effect<UploadedClip | null, SourceUnavailable>;
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
  readonly ptz?: SourcePtz;
  readonly picture?: SourcePicture;
  readonly uploads?: SourceUploads | undefined;
  /** What it shows about itself, such as a recorder's device, disks and channels. */
  readonly details?: Effect.Effect<Details, SourceUnavailable>;
}
