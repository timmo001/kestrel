/**
 * Puts what the build copies into the app in `vendor/`: the mise-pinned
 * go2rtc, yt-dlp and Node.js (`go2rtc.exe`, `yt-dlp.exe` and `node.exe` on
 * Windows), so the app has its own where mise isn't on the path, such as at
 * login, with Node.js's licence; and the CLI
 * with the server in it, built into one script, which the bundle's
 * `kestrel` command runs on the bundle's own Bun for `kestrel serve` and
 * the rest of the CLI. yt-dlp is its unpacked build, so it goes in its own
 * folder with the `_internal` folder it runs from.
 */
import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const vendor = join(import.meta.dir, "..", "vendor");

await mkdir(vendor, { recursive: true });

const mise = (command: string, tool: string) => {
  const run = Bun.spawnSync(["mise", command, tool], {
    cwd: import.meta.dir,
  });

  const path = run.stdout.toString().trim();

  if (!run.success || path === "") {
    console.error(`No ${tool} from mise; run \`mise install\` first`);
    process.exit(1);
  }

  return path;
};

for (const tool of ["go2rtc", "node"]) {
  const source = mise("which", tool);

  const target = join(vendor, basename(source));

  await copyFile(source, target);

  await chmod(target, 0o755);
}

const ytDlp = mise("which", "yt-dlp");

const ytDlpFolder = join(vendor, "yt-dlp");

await rm(ytDlpFolder, { recursive: true, force: true });

await mkdir(ytDlpFolder);

await copyFile(ytDlp, join(ytDlpFolder, basename(ytDlp)));

await chmod(join(ytDlpFolder, basename(ytDlp)), 0o755);

await cp(join(dirname(ytDlp), "_internal"), join(ytDlpFolder, "_internal"), {
  recursive: true,
});

const licenses = join(import.meta.dir, "..", "licenses");

await copyFile(join(licenses, "yt-dlp.LICENSE"), join(ytDlpFolder, "LICENSE"));

await copyFile(
  join(licenses, "yt-dlp.THIRD_PARTY_LICENSES"),
  join(ytDlpFolder, "THIRD_PARTY_LICENSES"),
);

await copyFile(
  join(mise("where", "node"), "LICENSE"),
  join(vendor, "node.LICENSE"),
);

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
