/**
 * The devices paired with the server, and how they pair. A device pairs once
 * with a one-time code, good for five minutes, and gets a token of its own;
 * only the token's SHA-256 hash is kept, in `devices.json` in the state
 * folder, which only this user can read. Ten wrong codes in five minutes
 * cancel every open one, so a code can't be guessed.
 *
 * Whoever can read the state folder owns the server: `owner.token` there
 * signs in as the owner, for `kestrel pair` and the desktop app on the same
 * machine. Delete it and restart to make a new one.
 *
 * A device can also ask for a one-time sign-in link, which signs a window in
 * as that device with a cookie, such as the desktop app's window.
 *
 * @module
 */
import { createHash, randomBytes } from "node:crypto";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect";
import type { Cookies, HttpServerRequest } from "effect/http";
import {
  Device,
  PairingRefused,
  sessionCookie,
  UnknownDevice,
  type DeviceKind,
  type PairingCode,
  type PairRequest,
} from "./Api.ts";
import { ownerTokenFile, stateFolder } from "./Folders.ts";
import { Identity } from "./Identity.ts";

/** Crockford's base32: no I, L, O or U, so a code reads back without mix-ups. */
const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const codeLife = 5 * 60_000;

/** Wrong codes allowed in `codeLife` before every open code is cancelled. */
const triesAllowed = 10;

/** How stale a device's last use gets before it's saved again. */
const lastSeenEvery = 10 * 60_000;

/** The owner, who signs in with `owner.token`. */
export const ownerId = "owner";

/** A new code: eight characters, each from a whole byte, so none is likelier. */
const newCode = () =>
  Array.from(randomBytes(8), (byte) => codeAlphabet[byte % 32]).join("");

/** A code as it's shown, such as `ABCD-EFGH`. */
export const showCode = (code: string) =>
  `${code.slice(0, 4)}-${code.slice(4)}`;

/** A code as typed, read the way Crockford's base32 reads: any case, O as 0, I and L as 1, no dashes or spaces. */
export const readCode = (typed: string) =>
  typed
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-Z]/g, "");

const newToken = () => randomBytes(32).toString("base64url");

/** What's kept of a token. */
export const hashOf = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const StoredDevice = Schema.Struct({
  ...Device.fields,
  token: Schema.String,
  session: Schema.optional(Schema.String),
});

interface StoredDevice extends Schema.Schema.Type<typeof StoredDevice> {}

const Stored = Schema.Struct({
  devices: Schema.Array(StoredDevice),
  ownerSession: Schema.optional(Schema.String),
});

interface Stored extends Schema.Schema.Type<typeof Stored> {}

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));

/** Who a token signs in as. */
export interface SignedIn {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind | "owner";
}

/** An open code: a pairing code, or a sign-in link for a device. */
interface Pending {
  readonly expires: number;
  readonly signsIn: Option.Option<string>;
}

/** A device as the API shows it, without its hashes. */
const publicDevice = (device: StoredDevice): Device => ({
  id: device.id,
  name: device.name,
  kind: device.kind,
  pairedAt: device.pairedAt,
  lastSeen: device.lastSeen,
});

/** The stored devices with `devices` in place of the list. */
const withDevices = (
  stored: Stored,
  devices: ReadonlyArray<StoredDevice>,
): Stored => ({ devices, ownerSession: stored.ownerSession });

const refused = (message: string) => new PairingRefused({ message });

/** The token a request signs in with: its bearer token, else its cookie. */
export const tokenOf = (request: HttpServerRequest.HttpServerRequest) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    request.headers["authorization"] ?? "",
  );

  return bearer?.[1] ?? request.cookies[sessionCookie];
};

/**
 * The window's cookie: kept from scripts, sent on links from other sites
 * but not their forms, and only over HTTPS when the request came that way,
 * since a browser drops a secure cookie set over plain HTTP.
 */
export const cookieOptions = (
  request: HttpServerRequest.HttpServerRequest,
): Cookies.Cookie["options"] => ({
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: "400 days",
  secure: request.headers["x-forwarded-proto"] === "https",
});

export class Devices extends Context.Service<
  Devices,
  {
    /** A new one-time code for another device to pair with. */
    readonly code: Effect.Effect<PairingCode>;
    /** Uses a code up, pairing a device, and returns its token. */
    readonly pair: (
      request: PairRequest,
    ) => Effect.Effect<
      { readonly device: Device; readonly token: string },
      PairingRefused
    >;
    /** A one-time code that signs a window in as `by`. */
    readonly link: (by: SignedIn) => Effect.Effect<string>;
    /** Uses a sign-in code up, returning the window's cookie. */
    readonly connect: (code: string) => Effect.Effect<string, PairingRefused>;
    /** Who a token or cookie signs in as, if anyone. */
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<Option.Option<SignedIn>>;
    readonly list: Effect.Effect<ReadonlyArray<Device>>;
    /** Unpairs a device, so its token and its window's cookie stop working. */
    readonly revoke: (id: string) => Effect.Effect<void, UnknownDevice>;
  }
>()("@timmo001/kestrel-server/Devices") {
  static readonly layer = Layer.effect(
    Devices,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const identity = yield* Identity;
      const directory = yield* stateFolder;
      const file = path.join(directory, "devices.json");
      const ownerFile = yield* ownerTokenFile;

      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });

      // Made once and kept, so `kestrel pair` reads the same one
      const ownerToken = yield* fs.readFileString(ownerFile).pipe(
        Effect.map((text) => text.trim()),
        Effect.filterOrFail((text) => text.length > 0),
        Effect.catch(() => {
          const token = newToken();

          return fs
            .writeFileString(ownerFile, `${token}\n`, { mode: 0o600 })
            .pipe(Effect.as(token));
        }),
      );

      const ownerHash = hashOf(ownerToken);

      const loaded = yield* fs.readFileString(file).pipe(
        Effect.map(decodeStored),
        Effect.orElseSucceed(() => Option.none<Stored>()),
      );

      const state = yield* Ref.make<Stored>(
        Option.getOrElse(loaded, () => ({ devices: [] })),
      );

      const pending = yield* Ref.make(new Map<string, Pending>());
      const wrong = yield* Ref.make<ReadonlyArray<number>>([]);

      const save = Effect.gen(function* () {
        yield* fs.writeFileString(file, JSON.stringify(yield* Ref.get(state)), {
          mode: 0o600,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Couldn't save the paired devices: ${error.message}`,
          ),
        ),
      );

      /** Adds an open code, dropping the ones past their time. */
      const open = Effect.fnUntraced(function* (
        signsIn: Option.Option<string>,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const code = newCode();
        const expires = now + codeLife;

        yield* Ref.update(pending, (codes) => {
          const kept = new Map(
            [...codes].filter(([, each]) => each.expires > now),
          );

          kept.set(code, { expires, signsIn });

          return kept;
        });

        return { code, expires };
      });

      /**
       * Uses an open code up. A wrong one counts towards cancelling every
       * open code, so guessing gets nowhere.
       */
      const useCode = Effect.fnUntraced(function* (typed: string) {
        const now = yield* Clock.currentTimeMillis;
        const code = readCode(typed);
        const codes = yield* Ref.get(pending);
        const found = codes.get(code);

        if (found !== undefined && found.expires > now) {
          yield* Ref.update(pending, (all) => {
            const kept = new Map(all);

            kept.delete(code);

            return kept;
          });

          return found;
        }

        const recent = [
          ...(yield* Ref.get(wrong)).filter((at) => at > now - codeLife),
          now,
        ];

        if (recent.length >= triesAllowed) {
          yield* Ref.set(pending, new Map());
          yield* Ref.set(wrong, []);
          yield* Effect.logWarning(
            "Cancelled every open pairing code after too many wrong ones",
          );
        } else {
          yield* Ref.set(wrong, recent);
        }

        return yield* refused("That code is wrong, used or out of time");
      });

      const code = Effect.gen(function* () {
        const { code: made, expires } = yield* open(Option.none());

        return {
          code: showCode(made),
          expires: new Date(expires).toISOString(),
          link: Option.getOrUndefined(
            Option.map(
              identity.url,
              (url) =>
                `${url}/pair#code=${showCode(made)}&server=${identity.id}`,
            ),
          ),
        };
      }).pipe(Effect.withSpan("Devices.code"));

      const pair = Effect.fn("Devices.pair")(function* (request: PairRequest) {
        const found = yield* useCode(request.code);

        if (Option.isSome(found.signsIn)) {
          return yield* refused("That's a sign-in link, not a pairing code");
        }

        const token = newToken();
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();

        const device: StoredDevice = {
          id: randomBytes(9).toString("base64url"),
          name: request.name,
          kind: request.kind,
          pairedAt: now,
          lastSeen: now,
          token: hashOf(token),
        };

        yield* Ref.update(state, (stored) =>
          withDevices(stored, [...stored.devices, device]),
        );

        yield* save;
        yield* Effect.logInfo(`Paired ${device.name} (${device.kind})`);

        return { device: publicDevice(device), token };
      });

      const link = Effect.fn("Devices.link")(function* (by: SignedIn) {
        return showCode((yield* open(Option.some(by.id))).code);
      });

      const connect = Effect.fn("Devices.connect")(function* (typed: string) {
        const found = yield* useCode(typed);

        if (Option.isNone(found.signsIn)) {
          return yield* refused("That's a pairing code, not a sign-in link");
        }

        const id = found.signsIn.value;
        const session = newToken();
        const stored = yield* Ref.get(state);

        if (id !== ownerId && !stored.devices.some((each) => each.id === id)) {
          return yield* refused("That device isn't paired any more");
        }

        // One window per device: a new sign-in replaces its last
        yield* Ref.set(
          state,
          id === ownerId
            ? { devices: stored.devices, ownerSession: hashOf(session) }
            : withDevices(
                stored,
                stored.devices.map((each) =>
                  each.id === id ? { ...each, session: hashOf(session) } : each,
                ),
              ),
        );

        yield* save;

        return session;
      });

      const authenticate = Effect.fn("Devices.authenticate")(function* (
        token: string,
      ) {
        const hash = hashOf(token);
        const stored = yield* Ref.get(state);

        if (hash === ownerHash || hash === stored.ownerSession) {
          return Option.some<SignedIn>({
            id: ownerId,
            name: identity.name,
            kind: "owner",
          });
        }

        const device = stored.devices.find(
          (each) => each.token === hash || each.session === hash,
        );

        if (device === undefined) return Option.none<SignedIn>();

        const now = yield* Clock.currentTimeMillis;

        if (
          device.lastSeen === undefined ||
          Date.parse(device.lastSeen) < now - lastSeenEvery
        ) {
          const lastSeen = new Date(now).toISOString();

          yield* Ref.update(state, (all) =>
            withDevices(
              all,
              all.devices.map((each) =>
                each.id === device.id ? { ...each, lastSeen } : each,
              ),
            ),
          );

          yield* save;
        }

        return Option.some<SignedIn>({
          id: device.id,
          name: device.name,
          kind: device.kind,
        });
      });

      const list = Ref.get(state).pipe(
        Effect.map((stored) => stored.devices.map(publicDevice)),
      );

      const revoke = Effect.fn("Devices.revoke")(function* (id: string) {
        const stored = yield* Ref.get(state);
        const device = stored.devices.find((each) => each.id === id);

        if (device === undefined) {
          return yield* new UnknownDevice({
            message: `No paired device has the id ${id}`,
          });
        }

        yield* Ref.set(
          state,
          withDevices(
            stored,
            stored.devices.filter((each) => each.id !== id),
          ),
        );

        yield* save;
        yield* Effect.logInfo(`Unpaired ${device.name} (${device.kind})`);
      });

      return Devices.of({
        code,
        pair,
        link,
        connect,
        authenticate,
        list,
        revoke,
      });
    }),
  );
}
