/**
 * Puts what the build copies into the app in `vendor/`: the mise-pinned
 * go2rtc (`go2rtc.exe` on Windows), so the app has its own where mise isn't
 * on the path, such as at login; and the CLI with the server in it, built
 * into one script, which the bundle's `kestrel` command runs on the bundle's
 * own Bun for `kestrel serve` and the rest of the CLI.
 */
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

const which = Bun.spawnSync(["mise", "which", "go2rtc"], {
  cwd: import.meta.dir,
});

const source = which.stdout.toString().trim();

if (!which.success || source === "") {
  console.error("No go2rtc from mise; run `mise install` first");
  process.exit(1);
}

const vendor = join(import.meta.dir, "..", "vendor");
const target = join(vendor, basename(source));

await mkdir(vendor, { recursive: true });

await copyFile(source, target);

await chmod(target, 0o755);

const cli = await Bun.build({
  entrypoints: [join(import.meta.dir, "../../cli/src/cli.ts")],
  target: "bun",
  minify: true,
  outdir: vendor,
  naming: "kestrel.js",
});

if (!cli.success) {
  for (const log of cli.logs) console.error(log);

  process.exit(1);
}
