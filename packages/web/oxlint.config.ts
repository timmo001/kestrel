/** Oxlint config: the shared Effect preset with type-aware rules and type checking. */
import recommendedEffect from "@timmo001/oxlint-rules/configs/recommended-effect";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [recommendedEffect],
  options: {
    typeAware: true,
    typeCheck: true,
    maxWarnings: 0,
  },
  ignorePatterns: [".agents/**", ".opencode/**", "dist/**"],
  overrides: [
    {
      // The router's one cast: a matched route's name and both codecs come
      // from the same entry of `routes`, which TypeScript can't correlate.
      files: ["src/router.ts"],
      rules: {
        "timmo/prefer-types-over-assertions": "off",
      },
    },
  ],
});
