/** The Kestrel docs site, built on the shared docs-kit defaults. */
import { docsConfig } from "@timmo001/docs-kit/blume";
import { defineConfig } from "blume";

export default defineConfig(
  docsConfig({
    title: "Kestrel",
    description:
      "One app for your cameras and recorders: live view, recordings, events and health, through a small server on your own network.",
    site: "kestrel.timmo.dev",
    github: { owner: "timmo001", repo: "kestrel" },
    navigation: {
      sidebar: ["/", "/install", "/running", "/api", "/agents", "/protocol"],
    },
  }),
);
