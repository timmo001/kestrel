/**
 * How Hutch builds the app: a Bun main process that runs the server and opens
 * the window, a preload script for the page, the built web client, the
 * built docs site, go2rtc, and the `kestrel` command with the CLI it runs,
 * for `kestrel serve` with no window. It uses the system's webview, not CEF.
 */
import type { ElectrobunConfig } from "electrobun";
import { version } from "../core/src/Version.ts";

const go2rtc = process.platform === "win32" ? "go2rtc.exe" : "go2rtc";

export default {
  app: {
    name: "Kestrel",
    identifier: "dev.timmo.kestrel",
    // The one version the server and every client share
    version,
  },
  runtime: {
    // It keeps running in the tray
    exitOnLastWindowClosed: false,
  },
  scripts: {
    preBuild: "scripts/vendor.ts",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      preload: {
        entrypoint: "src/preload/index.ts",
        format: "iife",
      },
    },
    copy: {
      "../web/dist": "web",
      "../../docs/dist/client": "docs",
      "../web/dist/icons/icon-192.png": "views/tray/icon.png",
      [`vendor/${go2rtc}`]: `go2rtc/${go2rtc}`,
      "licenses/go2rtc.LICENSE": "go2rtc/LICENSE",
      "../../LICENSE": "LICENSE",
      // The one `kestrel` command and the CLI it runs, with the server in it
      "vendor/kestrel.js": "cli/kestrel.js",
      "scripts/kestrel": "kestrel",
      "scripts/kestrel.cmd": "kestrel.cmd",
    },
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
      icon: "../web/dist/icons/icon-512.png",
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
