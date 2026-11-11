/**
 * Builds the app into `dist/`, which the server serves: the page script and
 * its CSS, the service worker, the manifest and icons from `pwa.config.ts`
 * and the logo, and the page with the PWA's head tags and the theme boot
 * script inlined, so the theme applies before the first paint.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { headTags, writePwa } from "@timmo001/groundwork-pwa/build";
import { themeBootScript } from "@timmo001/groundwork-tokens/page";
import config from "../pwa.config.ts";
import { themeOptions } from "./theme.ts";

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

const html = await Bun.file(path.join(root, "src/index.html")).text();

await Bun.write(
  path.join(outDir, "index.html"),
  html.replace(
    "<!-- pwa:head -->",
    `${headTags(config)}\n    <script>${themeBootScript(themeOptions)}</script>`,
  ),
);

console.log(`Built ${version} into ${path.relative(process.cwd(), outDir)}/`);
