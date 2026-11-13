/**
 * Which server the desktop app uses, kept in `desktop.json` in the config
 * folder: this computer's own, shared with other devices or not, or another
 * one it's paired with, by its address, its lasting id and this app's token.
 * It's never both, so there's one copy of the footage and nothing records a
 * camera twice. Only this user can read the file.
 */
import { configFolder } from "@timmo001/kestrel-server/folders";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

/** This computer's own server; with `share`, other devices can pair with it. */
export const Local = Schema.Struct({
  mode: Schema.tag("local"),
  share: Schema.Boolean,
});

export interface Local extends Schema.Schema.Type<typeof Local> {}

/** Another server this app is paired with. */
export const Remote = Schema.Struct({
  mode: Schema.tag("remote"),
  server: Schema.String,
  serverId: Schema.String,
  name: Schema.String,
  token: Schema.String,
});

export interface Remote extends Schema.Schema.Type<typeof Remote> {}

export const Connection = Schema.Union([Local, Remote]);

export type Connection = typeof Connection.Type;

/** Where a new install starts: this computer's server, for this computer alone. */
export const thisComputer: Local = { mode: "local", share: false };

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Connection));

const file = Effect.gen(function* () {
  const path = yield* Path.Path;

  return path.join(yield* configFolder, "desktop.json");
});

/** The saved connection, or this computer's server where there's none. */
export const readConnection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(yield* file).pipe(
    Effect.map((text) =>
      Option.getOrElse(decode(text), (): Connection => thisComputer),
    ),
    Effect.orElseSucceed((): Connection => thisComputer),
  );
});

/** Keeps the connection, where only this user can read it. */
export const writeConnection = Effect.fn("writeConnection")(function* (
  connection: Connection,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* file;

  yield* fs.makeDirectory(path.dirname(target), {
    recursive: true,
    mode: 0o700,
  });
  yield* fs.writeFileString(target, JSON.stringify(connection, null, 2), {
    mode: 0o600,
  });
});
