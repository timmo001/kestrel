/**
 * Where the server keeps its files, by the system's own conventions: the
 * config folder for what you set up, such as the sources, and the state
 * folder for what it keeps for itself, such as push subscriptions. Each
 * takes `KESTREL_CONFIG` or `KESTREL_STATE` first, then the XDG folders,
 * then Windows' `%APPDATA%` and `%LOCALAPPDATA%`, then the home folder.
 *
 * @module
 */
import { Config, Effect, Path } from "effect";

const home = Config.String("HOME").pipe(
  Config.orElse(() => Config.String("USERPROFILE")),
  Config.withDefault("."),
);

/** The folder for what you set up, such as `~/.config/kestrel`. */
export const configFolder = Effect.gen(function* () {
  const path = yield* Path.Path;

  return yield* Config.String("KESTREL_CONFIG").pipe(
    Config.orElse(() =>
      Config.String("XDG_CONFIG_HOME").pipe(
        Config.orElse(() => Config.String("APPDATA")),
        Config.map((folder) => path.join(folder, "kestrel")),
      ),
    ),
    Config.orElse(() =>
      home.pipe(Config.map((folder) => path.join(folder, ".config/kestrel"))),
    ),
  );
});

/** The folder for what the server keeps for itself, such as `~/.local/state/kestrel`. */
export const stateFolder = Effect.gen(function* () {
  const path = yield* Path.Path;

  return yield* Config.String("KESTREL_STATE").pipe(
    Config.orElse(() =>
      Config.String("XDG_STATE_HOME").pipe(
        Config.orElse(() => Config.String("LOCALAPPDATA")),
        Config.map((folder) => path.join(folder, "kestrel")),
      ),
    ),
    Config.orElse(() =>
      home.pipe(
        Config.map((folder) => path.join(folder, ".local/state/kestrel")),
      ),
    ),
  );
});
