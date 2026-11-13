/**
 * Who the server is to the devices that use it: an id made once and kept in
 * the state folder, so a device still knows its server when the address
 * changes; a name, `KESTREL_NAME` or the machine's; and the address other
 * devices reach it on, `KESTREL_URL` or the machine's first network address,
 * or none while it only listens on this machine.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { hostname as machineName, networkInterfaces } from "node:os";
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { stateFolder } from "./Folders.ts";

/** The addresses that only reach this machine. */
export const loopback = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

const Stored = Schema.Struct({ id: Schema.String });

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));

/** The machine's first IPv4 address on a network, if it has one. */
const networkAddress = () =>
  Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === "IPv4" && !address.internal)?.address;

export class Identity extends Context.Service<
  Identity,
  {
    readonly id: string;
    readonly name: string;
    /** Where other devices reach the server, without a trailing slash. */
    readonly url: Option.Option<string>;
  }
>()("@timmo001/kestrel-server/Identity") {
  static readonly layer = (options: {
    readonly hostname: string;
    readonly port: number;
  }) =>
    Layer.effect(
      Identity,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* stateFolder;
        const file = path.join(directory, "server.json");

        const kept = yield* fs.readFileString(file).pipe(
          Effect.map(decodeStored),
          Effect.orElseSucceed(() => Option.none()),
        );

        const id = Option.match(kept, {
          onNone: () => randomBytes(12).toString("base64url"),
          onSome: (stored) => stored.id,
        });

        if (Option.isNone(kept)) {
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(file, JSON.stringify({ id }), {
            mode: 0o600,
          });
        }

        const name = yield* Config.String("KESTREL_NAME").pipe(
          Config.withDefault(machineName()),
        );

        const given = yield* Config.option(Config.String("KESTREL_URL"));

        const url = Option.orElse(
          Option.map(given, (address) => address.replace(/\/+$/, "")),
          () =>
            loopback.has(options.hostname)
              ? Option.none()
              : Option.map(
                  Option.fromNullishOr(networkAddress()),
                  (address) => `http://${address}:${options.port}`,
                ),
        );

        return Identity.of({ id, name, url });
      }),
    );
}
