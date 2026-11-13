/**
 * Copies the mise-pinned go2rtc into `vendor/`, which the build puts in the
 * app, so the app has its own where mise isn't on the path, such as at login.
 * It's `go2rtc.exe` on Windows.
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
