/**
 * Builds the app into `dist/`, which the server serves: the page script and
 * its CSS, the service worker, the manifest and icons from `pwa.config.ts`
 * and the logo, and the page with the PWA's head tags, Kestrel's solved
 * theme and the theme boot script inlined, so the theme applies before the
 * first paint.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { headTags, writePwa } from "@timmo001/groundwork-pwa/build";
import { themeBootScript } from "@timmo001/groundwork-tokens/page";
import { parseTheme, runtimeTheme } from "@timmo001/groundwork-tokens/runtime";
import config from "../pwa.config.ts";
import { themeSettings } from "./theme.ts";

const root = path.join(import.meta.dir, "..");
const outDir = path.join(root, "dist");
const version = process.env.GROUNDWORK_PWA_VERSION ?? Date.now().toString(36);

await rm(outDir, { recursive: true, force: true });

for (const entry of ["src/index.ts", "src/sw.ts"]) {
  const result = await Bun.build({
    entrypoints: [path.join(root, entry)],
    outdir: outDir,
    target: "browser",
    minify: true,
    naming: { entry: "[name].[ext]", asset: "assets/[name]-[hash].[ext]" },
    define: { "process.env.GROUNDWORK_PWA_VERSION": JSON.stringify(version) },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);

    process.exit(1);
  }
}

await writePwa(config, { outDir, logo: path.join(root, "src/logo.svg") });

// Kestrel's own theme, solved into light, dark and Darker. It's the default,
// so a contrast miss fails the build rather than ship
const parsed = parseTheme(
  await Bun.file(path.join(root, "src/kestrel.theme.json")).text(),
);

// A plain script, so the decode's failure is read as data, not with Effect
if ("failure" in parsed) {
  console.error(`kestrel.theme.json doesn't decode: ${String(parsed.failure)}`);
  process.exit(1);
}

const solved = runtimeTheme(parsed.success);
const misses = solved.checks.filter((check) => !check.passes);

if (misses.length > 0) {
  for (const miss of misses) {
    console.error(
      `Kestrel theme, ${miss.mode}: ${miss.role} at ${miss.ratio.toFixed(2)}, under ${miss.target}`,
    );
  }

  process.exit(1);
}

const html = await Bun.file(path.join(root, "src/index.html")).text();

await Bun.write(
  path.join(outDir, "index.html"),
  html.replace(
    "<!-- pwa:head -->",
    `${headTags(config)}\n    <style id="kestrel-theme">${solved.css}</style>\n    <script>${themeBootScript(themeSettings)}</script>`,
  ),
);

console.log(`Built ${version} into ${path.relative(process.cwd(), outDir)}/`);
