/**
 * Renders the PNG branding (social preview, logo and Apple touch icon) from
 * `src/assets/logo.svg`. Run it with `bun run brand`.
 *
 * @module
 */
import { writeBrandImages } from "@timmo001/docs-kit";

const written = await writeBrandImages({
  logo: "src/assets/logo.svg",
  title: "Kestrel",
  tagline: ["Your cameras and recorders,", "watched over in one app."],
  site: "kestrel.timmo.dev",
  // From the logo: a step darker than its tile, with the kestrel's yellow
  background: "#22252a",
  accent: "#f2b31d",
  outputs: {
    socialPreview: "../.github/social-preview.png",
    logo: "public/logo.png",
    appleTouchIcon: "public/apple-touch-icon.png",
  },
});

for (const file of written) console.log(`Wrote ${file}`);
