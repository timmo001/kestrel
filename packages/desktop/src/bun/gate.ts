/**
 * The window's front door: a small page server on this computer that the
 * window always opens at. It sends the window on to the server's page,
 * signed in with a new one-time link each time, so the token stays in the
 * app. Where the server can't be reached, has unpaired this app or runs
 * another version, it says so and what to do, and it's where another server
 * is chosen and paired. It listens on this computer alone, under a path
 * that's new each launch, and only takes a form from its own pages.
 */
import { randomBytes } from "node:crypto";

import { isOlder, mismatchMessage, version } from "@timmo001/kestrel-core";
import type { FoundServer } from "@timmo001/kestrel-core/discovery";
import { Predicate } from "effect";

import type { Connection } from "./connection.ts";
import type { Status } from "./server.ts";
import { releasePage, updatesItself } from "./update.ts";

/** What the front door asks the app to do. */
export interface GateActions {
  /** The address to send the window to, or nothing while it can't go. */
  readonly signIn: () => Promise<string | undefined>;
  readonly status: () => Promise<Status>;
  readonly connection: () => Connection;
  /** The servers that answer on the network. */
  readonly servers: () => Promise<ReadonlyArray<FoundServer>>;
  /** Pairs with the server at `server` and uses it, or says why it couldn't. */
  readonly pair: (server: string, code: string) => Promise<string | undefined>;
  /** Uses this computer's own server, shared with other devices or not. */
  readonly useLocal: (share: boolean) => Promise<void>;
  /** Updates the app to `version`, or says why it couldn't. */
  readonly update: (version: string) => Promise<string | undefined>;
}

export interface Gate {
  /** The front door's origin, which the window's own pages come from. */
  readonly origin: string;
  /** Where the window opens. */
  readonly url: string;
  /** The page for choosing another server. */
  readonly chooseUrl: string;
  readonly stop: () => void;
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );

const style = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  form, .server { margin: 1rem 0; }
  .server { padding: 0.75rem 1rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 0.5rem; }
  .muted { opacity: 0.7; }
  input[type=text] { font: inherit; padding: 0.3rem 0.5rem; width: 12rem; }
  button { font: inherit; padding: 0.3rem 0.9rem; }
  .error { color: #c0392b; }
`;

const page = (title: string, body: string, refresh = false) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>${
      refresh ? '<meta http-equiv="refresh" content="2">' : ""
    }<style>${style}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const local = (share: boolean) =>
  `<form method="post" action="local"><label><input type="checkbox" name="share"${
    share ? " checked" : ""
  }> Let other devices pair with it</label> <button>Use this computer's server</button></form>`;

/** Says why the window can't open the server's page yet, and what to do. */
const statusPage = (status: Status, connection: Connection) => {
  const elsewhere = '<p><a href="choose">Use another server</a></p>';

  switch (status.state) {
    case "starting":
    case "up":
    case "remote":
      return page(
        "Kestrel",
        "<h1>Starting…</h1><p>Kestrel opens once the server answers.</p>",
        true,
      );
    case "down":
      return page(
        "Kestrel",
        "<h1>The server stopped</h1><p>It's starting again; this page opens it once it answers.</p>",
        true,
      );
    case "unreachable":
      return page(
        "Kestrel",
        `<h1>Can't reach ${escape(status.name)}</h1><p>Kestrel keeps trying, and finds it again if its address changed.</p><p><a href="./">Try again</a></p>${elsewhere}${local(false)}`,
      );
    case "unpaired":
      return page(
        "Kestrel",
        `<h1>${escape(status.name)} unpaired this computer</h1><p>Pair it again with a code from Settings, Devices on a paired browser.</p>${elsewhere}${local(false)}`,
      );
    case "mismatch": {
      const message = mismatchMessage({
        client: version,
        server: status.server,
        what: "This app",
        where: status.name,
      });

      const appOlder = isOlder(version, status.server);

      const action = !appOlder
        ? ""
        : updatesItself
          ? `<form method="post" action="update"><input type="hidden" name="version" value="${escape(status.server)}"><button>Update to ${escape(status.server)}</button></form>`
          : `<p><a href="${escape(releasePage(status.server))}">Open Kestrel ${escape(status.server)}'s release</a></p>`;

      return page(
        "Kestrel",
        `<h1>Kestrel needs updating</h1><p>${escape(message)}</p>${action}${elsewhere}${
          connection.mode === "remote" ? local(false) : ""
        }`,
      );
    }
  }
};

const choosePage = (
  servers: ReadonlyArray<FoundServer>,
  connection: Connection,
  error?: string,
) => {
  const found =
    servers.length === 0
      ? '<p class="muted">No Kestrel server answered on this network. Give its address below.</p>'
      : servers
          .map((server) =>
            server.version === version
              ? `<form class="server" method="post" action="pair"><strong>${escape(server.name)}</strong> <span class="muted">${escape(server.url)}</span><br><input type="hidden" name="server" value="${escape(server.url)}"><input type="text" name="code" placeholder="Pairing code" required autocomplete="off"> <button>Pair</button></form>`
              : `<div class="server"><strong>${escape(server.name)}</strong> <span class="muted">${escape(server.url)}</span><br>${escape(
                  mismatchMessage({
                    client: version,
                    server: server.version,
                    what: "This app",
                    where: server.name,
                  }),
                )}</div>`,
          )
          .join("");

  return page(
    "Use another server",
    `<h1>Use another server</h1>${
      error === undefined ? "" : `<p class="error">${escape(error)}</p>`
    }<p>Get a pairing code from Settings, Devices on a browser paired with the server, or <code>kestrel pair</code> on the server.</p>${found}<form class="server" method="post" action="pair"><strong>Another address</strong><br><input type="text" name="server" placeholder="http://192.168.1.20:7380" required> <input type="text" name="code" placeholder="Pairing code" required autocomplete="off"> <button>Pair</button></form><h1>Or this computer</h1>${local(
      connection.mode === "local" && connection.share,
    )}<p><a href="./">Back</a></p>`,
  );
};

/** Starts the front door on this computer, on a free port. */
export const startGate = (actions: GateActions): Gate => {
  const secret = randomBytes(16).toString("hex");
  const prefix = `/${secret}/`;
  let origin = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (!url.pathname.startsWith(prefix)) {
        return new Response("Not found", { status: 404 });
      }

      const route = url.pathname.slice(prefix.length);

      if (request.method === "GET" && route === "") {
        const target = await actions.signIn();

        return target === undefined
          ? statusPage(await actions.status(), actions.connection())
          : Response.redirect(target, 302);
      }

      if (request.method === "GET" && route === "choose") {
        return choosePage(await actions.servers(), actions.connection());
      }

      // Only a form from these pages, not another site the user has open
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin
      ) {
        return new Response("Not found", { status: 404 });
      }

      const form = await request.formData();

      const field = (name: string) => {
        const value = form.get(name);

        return Predicate.isString(value) ? value.trim() : "";
      };

      const home = `${origin}${prefix}`;

      switch (route) {
        case "pair": {
          const error = await actions.pair(
            field("server").replace(/\/+$/, ""),
            field("code"),
          );

          return error === undefined
            ? Response.redirect(home, 303)
            : choosePage(await actions.servers(), actions.connection(), error);
        }

        case "local":
          await actions.useLocal(field("share") === "on");

          return Response.redirect(home, 303);

        case "update": {
          const error = await actions.update(field("version"));

          return error === undefined
            ? page(
                "Updating Kestrel",
                "<h1>Updating Kestrel…</h1><p>The Setup is starting, and Kestrel opens again once it's done.</p>",
              )
            : page(
                "Kestrel",
                `<h1>Couldn't update</h1><p class="error">${escape(error)}</p><p><a href="./">Back</a></p>`,
              );
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });

  origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    url: `${origin}${prefix}`,
    chooseUrl: `${origin}${prefix}choose`,
    stop: () => void server.stop(true),
  };
};
