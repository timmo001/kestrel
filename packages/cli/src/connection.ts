/**
 * Which server the CLI talks to and the token it signs in with:
 * `KESTREL_SERVER` and `KESTREL_TOKEN` first, then what `kestrel pair` saved
 * in `client.json` in the config folder, then this machine's own server with
 * its owner token, where this user can read it. The token is never printed.
 *
 * @module
 */
import { configFolder, ownerTokenFile } from "@timmo001/kestrel-server/folders";
import {
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";

/** This machine's own server, where nothing else is set. */
export const localServer = "http://127.0.0.1:7380";

/** What `kestrel pair` keeps: the server, its id, and this CLI's token. */
export const SavedConnection = Schema.Struct({
  server: Schema.String,
  serverId: Schema.String,
  token: Schema.String,
});

export interface SavedConnection extends Schema.Schema.Type<
  typeof SavedConnection
> {}

const decodeSaved = Schema.decodeUnknownOption(
  Schema.fromJsonString(SavedConnection),
);

const savedFile = Effect.gen(function* () {
  const path = yield* Path.Path;

  return path.join(yield* configFolder, "client.json");
});

/** The connection `kestrel pair` saved, if any. */
export const readSaved = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(yield* savedFile).pipe(
    Effect.map(decodeSaved),
    Effect.orElseSucceed(() => Option.none<SavedConnection>()),
  );
});

/** Keeps a paired connection, where only this user can read it. */
export const writeSaved = Effect.fn("writeSaved")(function* (
  saved: SavedConnection,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* savedFile;

  yield* fs.makeDirectory(path.dirname(file), {
    recursive: true,
    mode: 0o700,
  });
  yield* fs.writeFileString(file, JSON.stringify(saved, null, 2), {
    mode: 0o600,
  });

  return file;
});

/** This machine's server's owner token, where this user can read it. */
export const ownerToken = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(yield* ownerTokenFile).pipe(
    Effect.map((text) => Option.some(Redacted.make(text.trim()))),
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
  );
});

/** The server to talk to, and the token to sign in with, if there is one. */
export const connection = Effect.gen(function* () {
  const saved = yield* readSaved;
  const given = yield* Config.option(Config.String("KESTREL_SERVER"));

  const server = Option.getOrElse(
    Option.orElse(given, () => Option.map(saved, (each) => each.server)),
    () => localServer,
  );

  const givenToken = yield* Config.option(Config.Redacted("KESTREL_TOKEN"));

  // The saved token only goes to the server it was saved for
  const savedToken = Option.flatMap(saved, (each) =>
    each.server === server
      ? Option.some(Redacted.make(each.token))
      : Option.none(),
  );

  const token = Option.isSome(givenToken)
    ? givenToken
    : Option.isSome(savedToken)
      ? savedToken
      : server === localServer
        ? yield* ownerToken
        : Option.none<Redacted.Redacted>();

  return { server, token, saved };
});
