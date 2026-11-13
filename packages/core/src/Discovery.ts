/**
 * Finding Kestrel servers on the home network over mDNS (DNS-SD): a server
 * announces `_kestrel._tcp` with its lasting id and version, and a client
 * browses for a few seconds and lists what answered, one entry per server
 * id, so a server is still known when its address changes.
 *
 * @module
 */
import { Bonjour, type Service } from "bonjour-service";
import { Duration, Effect, Option, Schema } from "effect";

/** The service type servers announce, as `_kestrel._tcp`. */
export const serviceType = "kestrel";

/** A server found on the network. */
export interface FoundServer {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Where to reach it, preferring an IPv4 address on the network. */
  readonly url: string;
  readonly addresses: ReadonlyArray<string>;
  readonly port: number;
}

/** What a server announces about itself. */
export interface Announcement {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly port: number;
}

const isLoopback = (address: string) =>
  address === "::1" || address.startsWith("127.");

/** The address to reach a found service on: IPv4 on the network first, then any on the network, then where it answered from. */
const addressOf = (service: Service) => {
  const addresses = (service.addresses ?? []).filter(
    (address) => !isLoopback(address) && !address.startsWith("fe80:"),
  );

  return (
    addresses.find((address) => !address.includes(":")) ??
    addresses[0] ??
    service.referer?.address
  );
};

/** What a server's TXT record carries. */
const Txt = Schema.Struct({ id: Schema.String, version: Schema.String });

const decodeTxt = Schema.decodeUnknownOption(Txt);

const found = (service: Service): FoundServer | undefined => {
  const txt = decodeTxt(service.txt);
  const address = addressOf(service);

  if (address === undefined || Option.isNone(txt)) return undefined;

  const host = address.includes(":") ? `[${address}]` : address;

  return {
    id: txt.value.id,
    name: service.name,
    version: txt.value.version,
    url: `http://${host}:${service.port}`,
    addresses: service.addresses ?? [],
    port: service.port,
  };
};

/** An mDNS responder for as long as the scope lasts. */
const responder = Effect.acquireRelease(
  Effect.sync(
    () =>
      new Bonjour(undefined, (error: Error) =>
        // A socket error, such as no multicast on this network, isn't worth
        // stopping the server for
        console.warn("mDNS stopped working", error),
      ),
  ),
  (bonjour) =>
    Effect.callback<void>((resume) => {
      bonjour.unpublishAll(() => bonjour.destroy(() => resume(Effect.void)));
    }).pipe(Effect.timeout("2 seconds"), Effect.ignore),
);

/** Announces a server on the network for as long as the scope lasts. */
export const announce = (server: Announcement) =>
  Effect.gen(function* () {
    const bonjour = yield* responder;

    bonjour.publish({
      name: server.name,
      type: serviceType,
      port: server.port,
      txt: { id: server.id, version: server.version },
    });
  });

/** The servers that answer within `duration`, one per server id. */
export const browse = (duration: Duration.Input = "3 seconds") =>
  Effect.gen(function* () {
    const bonjour = yield* responder;
    const servers = new Map<string, FoundServer>();

    const browser = bonjour.find({ type: serviceType }, (service) => {
      const server = found(service);

      if (server !== undefined) servers.set(server.id, server);
    });

    yield* Effect.sleep(duration);
    browser.stop();

    return [...servers.values()];
  }).pipe(Effect.scoped);
