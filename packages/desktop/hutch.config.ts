/**
 * Hutch's project config: Bun owns dependencies, through the workspace, and
 * the Electrobun release stays pinned to the one in package.json.
 */
export default {
  packageManager: "bun",
  electrobun: {
    version: "2.0.6",
  },
};
