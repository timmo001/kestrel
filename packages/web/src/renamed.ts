/**
 * Carries this browser's settings over from the app's old name, DVR Revival,
 * to Kestrel: the theme, each page's kept settings and the push client id,
 * so nothing is lost or subscribed twice. It runs before anything reads
 * them, and only once, as the old keys go once copied.
 */
// The theme is kept in parts under its key, as Groundwork's theme choices keep it
const themeParts = [
  "mode",
  "id",
  "custom",
  "custom-css",
  "custom-name",
  "custom-mode",
];

const renamed: ReadonlyArray<readonly [string, string]> = [
  ...themeParts.map((part): readonly [string, string] => [
    `dvr-revival:theme:${part}`,
    `kestrel:theme:${part}`,
  ]),
  ["dvr-revival:push-client", "kestrel:push-client"],
  ["dvr-revival.live", "kestrel.live"],
  ["dvr-revival.recordings", "kestrel.recordings"],
];

for (const [old, current] of renamed) {
  const value = localStorage.getItem(old);

  if (value === null) continue;

  if (localStorage.getItem(current) === null) {
    localStorage.setItem(current, value);
  }

  localStorage.removeItem(old);
}
