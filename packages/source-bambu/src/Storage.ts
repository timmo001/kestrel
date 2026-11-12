/**
 * The printer's storage over FTPS: the timelapse it makes of each print and
 * the stretches its camera records, both MJPEG AVI files named by when they
 * start, on the printer's own clock. It logs in as `bblp` with the LAN
 * access code on port 990, a connection per use, and the certificate is the
 * printer's own, so it isn't checked.
 *
 * @module
 */
import type { LocalTime } from "@timmo001/kestrel-core";
import { Client } from "basic-ftp";
import { Effect, Redacted, Schema } from "effect";

const ftpPort = 990;

/** How long the printer can go without answering, in milliseconds. */
const timeout = 15_000;

/** What a file is: a print's timelapse, or a stretch its camera recorded. */
export type FileKind = "timelapse" | "recording";

/** A video file on the printer. */
export interface PrinterFile {
  readonly path: string;
  readonly kind: FileKind;
  /** When it starts, such as `2026-07-30T20:56:07`. */
  readonly begin: LocalTime;
  readonly bytes: number;
}

export interface Login {
  readonly host: string;
  readonly accessCode: Redacted.Redacted;
}

/** The printer's storage couldn't be read, and why. */
export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  { message: Schema.String },
) {}

const folders = [
  {
    folder: "/timelapse",
    kind: "timelapse",
    pattern: /^video_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.avi$/,
  },
  {
    folder: "/ipcam",
    kind: "recording",
    pattern:
      /^ipcam-record\.(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.\d+\.avi$/,
  },
] as const;

/** Runs `use` on a logged-in connection, closed after. */
const withClient = <A>(
  login: Login,
  what: string,
  use: (client: Client) => Promise<A>,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new Client(timeout);

        try {
          await client.access({
            host: login.host,
            port: ftpPort,
            user: "bblp",
            password: Redacted.value(login.accessCode),
            secure: "implicit",
            secureOptions: { rejectUnauthorized: false },
          });
        } catch (error) {
          client.close();
          throw error;
        }

        return client;
      },
      catch: () =>
        new StorageError({
          message:
            "can't be reached over FTP, or turned down its access code there",
        }),
    }),
    (client) =>
      Effect.tryPromise({
        try: () => use(client),
        catch: () => new StorageError({ message: `couldn't ${what}` }),
      }),
    (client) => Effect.sync(() => client.close()),
  );

/** Every timelapse and recording on the printer, oldest first. */
export const listFiles = (login: Login) =>
  withClient(login, "list its videos", async (client) => {
    const found: Array<PrinterFile> = [];

    for (const each of folders) {
      for (const entry of await client.list(each.folder)) {
        const match = each.pattern.exec(entry.name);

        if (!entry.isFile || match === null) continue;

        found.push({
          path: `${each.folder}/${entry.name}`,
          kind: each.kind,
          begin: `${match[1]}T${match[2]}:${match[3]}:${match[4]}`,
          bytes: entry.size,
        });
      }
    }

    return found.toSorted((a, b) => a.begin.localeCompare(b.begin));
  });

/** When each file was last written to, which is when it ends, by its path. */
export const lastWritten = (login: Login, paths: ReadonlyArray<string>) =>
  withClient(login, "read when its videos end", async (client) => {
    const ends = new Map<string, LocalTime>();

    for (const path of paths) {
      // The printer answers in its own clock, which this reads as UTC
      ends.set(path, (await client.lastMod(path)).toISOString().slice(0, 19));
    }

    return ends;
  });

/** Downloads a file to a local path. */
export const download = (login: Login, remote: string, local: string) =>
  withClient(login, "download a video", async (client) => {
    await client.downloadTo(local, remote);
  });
