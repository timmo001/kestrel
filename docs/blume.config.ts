/** The Kestrel docs site, built on the shared docs-kit defaults. */
import { docsConfig } from "@timmo001/docs-kit/blume";
import { defineConfig } from "blume";

export default defineConfig(
  docsConfig({
    title: "Kestrel",
    description:
      "A web client and bridge for Raysharp-made recorders, such as the Swann DVR8-4575.",
    site: "kestrel.timmo.dev",
    github: { owner: "timmo001", repo: "kestrel" },
    navigation: {
      sidebar: ["/", "/running", "/api", "/agents", "/protocol"],
    },
  }),
);
