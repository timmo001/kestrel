/**
 * The sources the server serves, and finding one, or one of their cameras,
 * by id. For now that's the Raysharp recorder alone, as `swann`; sources
 * get set up in the app later (timmo001/kestrel#11).
 *
 * @module
 */
import {
  NotSupported,
  UnknownSource,
  type Source,
} from "@timmo001/kestrel-core";
import * as Raysharp from "@timmo001/kestrel-source-raysharp";
import { Context, Effect, Layer } from "effect";

export class Sources extends Context.Service<
  Sources,
  {
    readonly all: ReadonlyArray<Source>;
    /** The source with this id. */
    readonly find: (id: string) => Effect.Effect<Source, UnknownSource>;
  }
>()("@timmo001/kestrel-server/Sources") {
  static readonly layer = Layer.effect(
    Sources,
    Effect.gen(function* () {
      const all: ReadonlyArray<Source> = [
        yield* Raysharp.make({ id: "swann", name: "Swann recorder" }),
      ];

      return Sources.of({
        all,
        find: (id) => {
          const found = all.find((source) => source.id === id);

          return found === undefined
            ? Effect.fail(
                new UnknownSource({ message: `There's no source ${id}` }),
              )
            : Effect.succeed(found);
        },
      });
    }),
  );
}

/** A source's optional capability, or `NotSupported` when it hasn't one. */
export const capability = <A>(
  source: Source,
  value: A | undefined,
  what: string,
) =>
  value === undefined
    ? Effect.fail(
        new NotSupported({ message: `${source.name} has no ${what}` }),
      )
    : Effect.succeed(value);
