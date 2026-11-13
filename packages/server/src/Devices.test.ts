/**
 * Checks the ways pairing could quietly let someone in: a code that works
 * twice or late, guessing, a removed device that still works, a sign-in link
 * that works twice, or a token kept where it could be read.
 */
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
} from "effect";
import { TestClock } from "effect/testing";
import { Devices, hashOf, ownerId, readCode } from "./Devices.ts";
import { stateFolder } from "./Folders.ts";
import { Identity } from "./Identity.ts";

/** Runs `program` with a `Devices` over a new, empty state folder. */
const run = <A, E>(
  program: Effect.Effect<A, E, Devices | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const state = yield* fs.makeTempDirectoryScoped({
      prefix: "kestrel-devices-",
    });

    const config = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ KESTREL_STATE: state }),
    );

    const devices = Devices.layer.pipe(
      Layer.provide(Identity.layer({ hostname: "127.0.0.1", port: 7380 })),
    );

    return yield* program.pipe(
      Effect.provide(Layer.provideMerge(devices, config)),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.provide(BunServices.layer),
    Effect.runPromise,
  );

/** A file in the state folder, as it's saved. */
const saved = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return yield* fs.readFileString(path.join(yield* stateFolder, name));
  });

const browser = (code: string) =>
  ({ code, name: "Test browser", kind: "browser" }) as const;

test("a pairing code works once", async () => {
  const refused = await run(
    Effect.gen(function* () {
      const devices = yield* Devices;
      const { code } = yield* devices.code;

      yield* devices.pair(browser(code));

      return yield* Effect.flip(devices.pair(browser(code)));
    }),
  );

  expect(refused._tag).toBe("PairingRefused");
});

test("a code past its five minutes is refused", async () => {
  const refused = await run(
    Effect.gen(function* () {
      const devices = yield* Devices;
      const { code } = yield* devices.code;

      yield* TestClock.adjust("5 minutes");

      return yield* Effect.flip(devices.pair(browser(code)));
    }),
  );

  expect(refused._tag).toBe("PairingRefused");
});

test("ten wrong codes cancel the open ones", async () => {
  const refused = await run(
    Effect.gen(function* () {
      const devices = yield* Devices;
      const { code } = yield* devices.code;

      for (let wrong = 0; wrong < 10; wrong++) {
        yield* Effect.flip(devices.pair(browser("0000-0000")));
      }

      return yield* Effect.flip(devices.pair(browser(code)));
    }),
  );

  expect(refused._tag).toBe("PairingRefused");
});

test("a code reads back however it's typed", () => {
  expect(readCode("abcd-efgh")).toBe("ABCDEFGH");
  expect(readCode(" o1il oo ")).toBe("011100");
});

test("a removed device's token stops working, and only its hash is kept", async () => {
  const result = await run(
    Effect.gen(function* () {
      const devices = yield* Devices;
      const { code } = yield* devices.code;

      const paired = yield* devices.pair({
        code,
        name: "Laptop",
        kind: "cli",
      });

      const before = yield* devices.authenticate(paired.token);

      yield* devices.revoke(paired.device.id);

      const after = yield* devices.authenticate(paired.token);

      return {
        token: paired.token,
        before,
        after,
        file: yield* saved("devices.json"),
      };
    }),
  );

  expect(Option.isSome(result.before)).toBe(true);
  expect(Option.isNone(result.after)).toBe(true);
  expect(result.file).not.toContain(result.token);
});

test("the owner token signs in as the owner, and a sign-in link works once", async () => {
  const result = await run(
    Effect.gen(function* () {
      const devices = yield* Devices;
      const owner = { id: ownerId, name: "server", kind: "owner" } as const;
      const code = yield* devices.link(owner);
      const session = yield* devices.connect(code);
      const again = yield* Effect.flip(devices.connect(code));

      return {
        window: yield* devices.authenticate(session),
        again,
        session,
        ownerToken: (yield* saved("owner.token")).trim(),
        file: yield* saved("devices.json"),
      };
    }),
  );

  expect(result.ownerToken.length).toBeGreaterThan(30);
  expect(Option.map(result.window, (who) => who.kind)).toEqual(
    Option.some("owner"),
  );
  expect(result.again._tag).toBe("PairingRefused");
  expect(result.file).not.toContain(result.session);
  expect(result.file).toContain(hashOf(result.session));
});
