/** The DVR Revival docs site, built on the shared docs-kit defaults. */
import { docsConfig } from "@timmo001/docs-kit/blume";
import { defineConfig } from "blume";

export default defineConfig(
  docsConfig({
    title: "DVR Revival",
    description:
      "A web client and bridge for Raysharp-made recorders, such as the Swann DVR8-4575.",
    site: "dvr-revival.timmo.dev",
    github: { owner: "timmo001", repo: "dvr-revival" },
    navigation: {
      sidebar: ["/", "/running", "/api", "/protocol"],
    },
  }),
);
