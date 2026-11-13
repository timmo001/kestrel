/**
 * How Hutch builds the app: a Bun main process that runs the server and opens
 * the window, a preload script for the page, the built web client and
 * go2rtc. It uses the system's webview, not CEF.
 */
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Kestrel",
    identifier: "dev.timmo.kestrel",
    version: "0.0.1",
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
      "../web/dist/icons/icon-192.png": "views/tray/icon.png",
      "vendor/go2rtc": "go2rtc/go2rtc",
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
