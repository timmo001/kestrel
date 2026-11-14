/**
 * Kestrel's version, which the server and every client share: a client
 * only works with a server of the same version, so the two never disagree on
 * the API. A release's tag must match it, and only releases are packaged.
 *
 * @module
 */

export const version = "0.5.16";

/** The header a client sends its version in. */
export const versionHeader = "x-kestrel-version";

/** Whether `a` is an older version than `b`, comparing each number in turn. */
export const isOlder = (a: string, b: string) => {
  const parts = (text: string) => text.split(".").map((part) => Number(part));
  const [left, right] = [parts(a), parts(b)];

  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);

    if (difference !== 0) return difference < 0;
  }

  return false;
};

/** How to update each side, by where it's installed. */
export const updateSteps = {
  client:
    "on Arch, `sudo pacman -Syu`; on Debian, Ubuntu or Fedora, install the new package from https://github.com/timmo001/kestrel/releases/latest; with mise, `mise up`; the Windows app updates itself when you choose Update",
  server:
    "in Home Assistant, update the Kestrel app under Settings, Apps; in Docker, pull ghcr.io/timmo001/kestrel and start it again; on Linux, update the kestrel-nvr package and restart its service",
} as const;

/**
 * What to tell someone whose client and server differ: which is older, and
 * how to update it.
 */
export const mismatchMessage = (options: {
  readonly client: string;
  readonly server: string;
  /** What the client is, such as `This CLI`. */
  readonly what: string;
  /** Where the server is, such as its address. */
  readonly where: string;
}) => {
  const clientOlder = isOlder(options.client, options.server);

  return `${options.what} is Kestrel ${options.client} and the server at ${options.where} runs ${options.server}, and they must match. ${
    clientOlder
      ? `Update ${options.what.replace(/^This/, "this")}: ${updateSteps.client}`
      : `Update the server: ${updateSteps.server}`
  }.`;
};
