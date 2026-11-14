/**
 * A Reolink camera's FTP uploads to Kestrel: the `SetFtp` settings that
 * point it at Kestrel's receiver or stop it, and when a file it sends
 * starts, read from its name, such as `Front Door_01_20260713123456.mp4`.
 * Only a camera on its own sends this way; a hub or recorder hands its files
 * over by replaying them.
 *
 * @module
 */
import { createSocket } from "node:dgram";
import { isIPv6 } from "node:net";
import { Effect, Schema } from "effect";

/** The folder its clips go in on Kestrel's receiver, which needn't exist. */
export const remoteDir = "kestrel";

/** Its FTP settings, as far as Kestrel reads them, from the older `GetFtp`. */
export const Ftp = Schema.Struct({
  Ftp: Schema.Struct({
    server: Schema.String,
    port: Schema.Number,
    userName: Schema.optional(Schema.String),
    remoteDir: Schema.optional(Schema.String),
    schedule: Schema.optional(Schema.Struct({ enable: Schema.Number })),
  }),
});

export interface Ftp extends Schema.Schema.Type<typeof Ftp> {}

/** What it can do on the device as a whole, as each ability's version. */
export const DeviceAbility = Schema.Struct({
  Ability: Schema.Struct({
    ftpTest: Schema.optional(
      Schema.Struct({ ver: Schema.optional(Schema.Number) }),
    ),
  }),
});

/** Where Kestrel's receiver is and the login it made, as `SetFtp` and `TestFtp` take them. */
export const pointedAt = (target: {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}) => ({
  Ftp: {
    server: target.host,
    port: target.port,
    userName: target.user,
    password: target.password,
    remoteDir,
    anonymous: 0,
    schedule: { enable: 1 },
  },
});

/** Stops it sending, leaving the rest as it is, as reolink_aio turns it off. */
export const stopped = { Ftp: { schedule: { enable: 0 } } };

/** Whether its settings send to this receiver with this login now. */
export const sendsTo = (
  saved: Ftp,
  target: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
  },
) =>
  saved.Ftp.server === target.host &&
  saved.Ftp.port === target.port &&
  saved.Ftp.userName === target.user &&
  saved.Ftp.schedule?.enable === 1;

const stamp = /(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})(?!\d)/;

/** When a clip it sent starts, by its own clock, from its name; `null` for anything but a video named with its time. */
export const clipStart = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);

  if (!/\.mp4$/i.test(name)) return null;

  const match = stamp.exec(name);

  if (match === null) return null;

  const [, year, month, day, hour, minute, second] = match;
  const begin = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

  // Its own clock, read as if it were UTC, so an impossible time shows up
  const parsed = new Date(`${begin}Z`);

  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== begin
    ? null
    : begin;
};

/** This machine's address on the way to `host`, which the camera reaches it on; nothing is sent. */
export const addressToward = (host: string) =>
  Effect.callback<string, Error>((resume) => {
    const socket = createSocket(isIPv6(host) ? "udp6" : "udp4");

    socket.once("error", (error) => {
      socket.close();
      resume(Effect.fail(error));
    });

    socket.connect(9, host, () => {
      const { address } = socket.address();

      socket.close();
      resume(Effect.succeed(address));
    });
  });
