/**
 * Message numbers, request bodies and reply parsers for the parts of the
 * protocol this client uses. Layouts follow the vendor SDK's protocol header.
 *
 * @module
 */
import type {
  AlarmEvent,
  AlarmKind,
  DeviceInfo,
  DiskState,
  LocalTime,
  RecordedDay,
  RecorderStatus,
  Recording,
  RecordingMode,
  RecordingReason,
} from "@timmo001/kestrel-core/domain";
import { reader, writer, type Reader, type Writer } from "./Codec.ts";

/** Message types. */
export const MessageType = {
  login: 31,
  heartbeat: 32,
  queryRecord: 111,
  recordPlay: 121,
  recordPlayFeedback: 122,
  recordPlayControl: 124,
  downloadRecordFile: 131,
  status: 890,
  alarmReport: 891,
  alarmSubscribe: 896,
} as const;

/** Message subtypes. */
export const Subtype = {
  recordDetail: 101,
  recordDayOutline: 102,
  /** Playback feedback: send more. */
  recordDataInsufficient: 121,
  /** Comes back blank on firmware SRV7.1.0; 614 fills the same layout. */
  allStatus: 610,
  statusOnly: 614,
  pirAlarm: 187,
  videoLossAlarm: 189,
  motionAlarm: 191,
  inputAlarm: 192,
  alarmDesired: 196,
  diskAlarm: 202,
  recordStatus: 212,
  diskStatus: 213,
} as const;

/** What the recorder's ack codes mean. */
export const ackReasons: ReadonlyMap<number, string> = new Map([
  [0, "Success"],
  [1, "Fail"],
  [2, "Unknown message type"],
  [10, "User already logged in"],
  [11, "Unknown username"],
  [12, "Wrong password"],
  [13, "Blocked by the IP filter"],
  [14, "User disabled"],
  [15, "Password change required"],
  [18, "IP forbidden"],
  [50, "Not allowed for this user"],
  [51, "Bad parameter"],
  [66, "Too many users"],
  [322, "Another playback or download is running on the recorder"],
]);

/** The ack a playback gets while another playback or download is running. */
export const playbackBusy = 322;

/** The two bytes at offset 6 of a login reply that mark a Raysharp device ("RS"). */
const raysharpMark = 0x5253;

/** A recorder wall-clock time as its parts. */
export interface TimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Reads the 8-byte DateTime struct, or null when it's empty. */
const readTime = (body: Reader, offset: number): LocalTime | null => {
  const year = body.u16(offset);

  if (year === 0) return null;

  return (
    `${year}-${pad(body.u8(offset + 2))}-${pad(body.u8(offset + 3))}` +
    `T${pad(body.u8(offset + 4))}:${pad(body.u8(offset + 5))}:${pad(body.u8(offset + 6))}`
  );
};

const writeTime = (body: Writer, offset: number, time: TimeParts) => {
  body.u16(offset, time.year);
  body.u8(offset + 2, time.month);
  body.u8(offset + 3, time.day);
  body.u8(offset + 4, time.hour);
  body.u8(offset + 5, time.minute);
  body.u8(offset + 6, time.second);
};

/** Turns `2026-11-11T22:24:31` into its parts. */
export const timeParts = (time: LocalTime): TimeParts => {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = time
    .split(/[-T:]/)
    .map(Number);

  return { year, month, day, hour, minute, second };
};

/**
 * The 80-byte login request: username and password in 36-byte fields, then a
 * flags word with the language in the top byte (2, English) and alarm reports
 * in bit 0. The caller should zero the bytes once they're sent.
 */
export const loginRequest = (options: {
  readonly username: string;
  readonly password: string;
  readonly alarms: boolean;
}): Uint8Array => {
  const body = writer(80);
  body.text(0, 36, options.username);
  body.text(36, 36, options.password);
  body.u32(76, (2 << 24) | (options.alarms ? 1 : 0));

  return body.bytes;
};

/** Whether a login reply comes from a Raysharp device. */
export const isRaysharpLogin = (bytes: Uint8Array) =>
  bytes.length >= 8 && reader(bytes).u16(6) === raysharpMark;

/** The 1232-byte login reply. Model and serial sit past the original layout, so older firmware may leave them out. */
export const parseLogin = (bytes: Uint8Array): DeviceInfo => {
  const body = reader(bytes);

  return {
    firmware: body.text(8, 36),
    name: body.text(44, 36),
    mac: body.text(80, 36),
    deviceId: body.u32(116),
    channels: body.u8(166),
    alarmInputs: body.u8(168),
    alarmOutputs: body.u8(169),
    isAdmin: body.u8(173) !== 0,
    audioChannels: body.u8(174),
    model: body.text(588, 36),
    serial: body.text(624, 32),
  };
};

/**
 * The user key from a login reply. Requests on a second connection, such as
 * downloads, carry it in place of a login of their own.
 */
export const parseUserKey = (bytes: Uint8Array) => reader(bytes).u32(160);

const diskStates: ReadonlyArray<DiskState> = [
  "none",
  "ok",
  "unformatted",
  "format error",
  "full",
  "bad",
];

const recordingModes: ReadonlyArray<RecordingMode> = [
  "stopped",
  "normal",
  "manual",
  "motion",
  "alarm input",
  "motion and alarm input",
  "smart",
  "PIR",
  "motion and PIR",
  "PIR and alarm input",
  "motion, PIR and alarm input",
];

/** The smallest status reply this parser reads: up to the per-channel recording modes. */
export const statusMinimumSize = 332;

/**
 * The start of the status reply (DevAllStatusRpt): the clock, per-channel
 * bitmasks, disk states at 36 and recording modes at 300. Later fields move
 * between firmware releases, so they're left alone.
 */
export const parseStatus = (
  bytes: Uint8Array,
  channels: number,
): RecorderStatus => {
  const body = reader(bytes);

  const bit = (offset: number, channel: number) =>
    (body.u32(offset) & (1 << channel)) !== 0;

  return {
    time: readTime(body, 0),
    disks: Array.from({ length: 8 }, (_, index) => ({
      disk: index + 1,
      code: body.u8(36 + index),
    }))
      .filter((disk) => disk.code !== 0)
      .map((disk) => ({
        disk: disk.disk,
        state: diskStates[disk.code] ?? "unknown",
      })),
    channels: Array.from({ length: channels }, (_, channel) => ({
      channel: channel + 1,
      recordingEnabled: bit(8, channel),
      recording: bit(12, channel),
      recordingMode: recordingModes[body.u8(300 + channel)] ?? "unknown",
      motionEnabled: bit(16, channel),
      motion: bit(20, channel),
      videoLoss: bit(32, channel),
    })),
  };
};

const allTypes = 0xffffffff;

/**
 * The 136-byte recording search (QueryRecordReq). Channels are numbered from
 * 1 here; the request numbers them from 0. The day outline takes a channel
 * mask in both the channel field and the first extended mask.
 */
export const recordQuery = (
  options:
    | {
        readonly kind: "detail";
        readonly channel: number;
        readonly begin: LocalTime;
        readonly end: LocalTime;
      }
    | {
        readonly kind: "outline";
        readonly channels: ReadonlyArray<number>;
        readonly begin: LocalTime;
        readonly end: LocalTime;
      },
): Uint8Array => {
  const body = writer(136);

  if (options.kind === "detail") {
    body.u32(0, options.channel - 1);
  } else {
    const mask = options.channels.reduce(
      (value, channel) => value | (1 << (channel - 1)),
      0,
    );

    body.u32(0, mask);
    body.u32(24, mask);
  }

  writeTime(body, 4, timeParts(options.begin));
  writeTime(body, 12, timeParts(options.end));
  body.u32(20, allTypes);

  return body.bytes;
};

/** Which of a channel's streams to send: the full one or the small sub stream. */
export type RecordedStream = "main" | "sub";

/**
 * A download (DownloadRecordFileReq, 24 bytes) of one stretch of recording:
 * its size, the user key, the channel (from 0 on the wire) and the stream,
 * then one 28-byte record of the kind a search returns.
 *
 * The record is sent as "all types, size unknown", which firmware SRV7.1.0
 * takes for any range. It picks the file by the range's end, so a range must
 * end inside one file: one that ends on a file's last second gets the next
 * file instead, from that file's start. The SDK allows several records in one
 * request, but this firmware only sends the first.
 */
export const downloadRequest = (options: {
  readonly userKey: number;
  readonly channel: number;
  readonly stream: RecordedStream;
  readonly begin: LocalTime;
  readonly end: LocalTime;
}): Uint8Array => {
  const body = writer(52);
  body.u32(0, 24);
  body.u32(4, options.userKey);
  body.u32(8, options.channel - 1);
  body.u8(12, options.stream === "sub" ? 1 : 0);
  body.u32(24, 28);
  writeTime(body, 28, timeParts(options.begin));
  writeTime(body, 36, timeParts(options.end));
  body.u32(44, allTypes);
  body.u32(48, 0);

  return body.bytes;
};

/**
 * A playback (RecordPlayReq, 68 bytes): the user key, the channel (from 0
 * on the wire), the type, the range and the stream at 28. With a key frame
 * step set through the play control message (see `Session.keyFrames`) it
 * sends key frames only.
 */
export const playRequest = (options: {
  readonly userKey: number;
  readonly channel: number;
  readonly stream: RecordedStream;
  readonly begin: LocalTime;
  readonly end: LocalTime;
}): Uint8Array => {
  const body = writer(68);
  body.u32(0, options.userKey);
  body.u32(4, options.channel - 1);
  body.u32(8, allTypes);
  writeTime(body, 12, timeParts(options.begin));
  writeTime(body, 20, timeParts(options.end));
  body.u8(28, options.stream === "sub" ? 1 : 0);

  return body.bytes;
};

const reasonBits: ReadonlyArray<readonly [number, RecordingReason]> = [
  [0x1, "normal"],
  [0x2, "alarm"],
  [0x4, "motion"],
  [0x8, "alarm input"],
  [0x10000, "PIR"],
  [0x40000, "manual"],
];

/** The reasons a recording's type bits name. */
export const recordingReasons = (type: number): Array<RecordingReason> =>
  reasonBits.flatMap(([bit, reason]) => ((type & bit) !== 0 ? [reason] : []));

/** Walks records that each start with their own size, stopping at a bad one. */
const eachRecord = (
  bytes: Uint8Array,
  minimum: number,
  read: (body: Reader, offset: number, size: number) => void,
) => {
  const body = reader(bytes);

  for (let offset = 0; offset + 4 <= bytes.length;) {
    const size = body.u32(offset);

    if (size < minimum || offset + size > bytes.length) return;
    read(body, offset, size);
    offset += size;
  }
};

/** Recordings from a detail search. Each record is 28 bytes on this firmware, with the size at 24. */
export const parseRecordings = (
  bytes: Uint8Array,
  channel: number,
): Array<Recording> => {
  const recordings: Array<Recording> = [];
  eachRecord(bytes, 24, (body, offset, size) => {
    const begin = readTime(body, offset + 4);
    const end = readTime(body, offset + 12);

    if (begin === null || end === null) return;
    recordings.push({
      channel,
      begin,
      end,
      reasons: recordingReasons(body.u32(offset + 20)),
      bytes: size >= 28 ? body.u32(offset + 24) : null,
    });
  });

  return recordings;
};

/**
 * Days with recordings from a day outline. Only the date is reliable: firmware
 * SRV7.1.0 leaves junk in the time of day.
 */
export const parseRecordedDays = (bytes: Uint8Array): Array<RecordedDay> => {
  const days: Array<RecordedDay> = [];
  eachRecord(bytes, 12, (body, offset) => {
    const time = readTime(body, offset + 4);

    if (time === null) return;
    days.push({
      date: time.slice(0, 10),
      reasons: recordingReasons(body.u8(offset + 11)),
    });
  });

  return days;
};

const channelAlarms: ReadonlyMap<number, AlarmKind> = new Map([
  [Subtype.motionAlarm, "motion"],
  [Subtype.pirAlarm, "PIR"],
  [Subtype.videoLossAlarm, "video loss"],
  [Subtype.inputAlarm, "alarm input"],
]);

/**
 * An alarm report. Motion, PIR, video loss and alarm input reports start with
 * the channel (from 0), a status (1 on, 0 off) and the time; recording status
 * reports put the time at 4 and the channel at 12; disk reports put the time
 * at 36. This hasn't been seen from a recorder yet, so it's checked in use.
 */
export const parseAlarm = (subtype: number, bytes: Uint8Array): AlarmEvent => {
  const body = reader(bytes);
  const size = bytes.length;
  const channelKind = channelAlarms.get(subtype);

  if (channelKind !== undefined) {
    return {
      kind: channelKind,
      subtype,
      channel: size >= 4 ? body.u32(0) + 1 : null,
      active: size >= 8 ? body.i32(4) !== 0 : null,
      time: size >= 16 ? readTime(body, 8) : null,
      size,
    };
  }

  if (subtype === Subtype.recordStatus) {
    const channel = body.u32(12);

    return {
      kind: "recording status",
      subtype,
      channel: size >= 16 && channel !== allTypes ? channel + 1 : null,
      active: size >= 17 ? body.u8(16) !== 0 : null,
      time: size >= 12 ? readTime(body, 4) : null,
      size,
    };
  }

  if (subtype === Subtype.diskStatus || subtype === Subtype.diskAlarm) {
    return {
      kind: subtype === Subtype.diskStatus ? "disk status" : "disk alarm",
      subtype,
      channel: null,
      active: null,
      time: size >= 44 ? readTime(body, 36) : null,
      size,
    };
  }

  return {
    kind: "other",
    subtype,
    channel: null,
    active: null,
    time: null,
    size,
  };
};
