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
  tagline: ["A web client and bridge for", "Raysharp-made recorders."],
  site: "kestrel.timmo.dev",
  // Groundwork's Base theme, the app's default (timmo001/kestrel#7)
  // (timmo001/kestrel#7)
  background: "#1c1e22",
  accent: "#e7e9ee",
  outputs: {
    socialPreview: "../.github/social-preview.png",
    logo: "public/logo.png",
    appleTouchIcon: "public/apple-touch-icon.png",
  },
});

for (const file of written) console.log(`Wrote ${file}`);
