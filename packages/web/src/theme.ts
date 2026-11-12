/**
 * The page's theme settings, shared by the boot script the build inlines and
 * the page: Base by default, with every Groundwork theme and mode on offer
 * (timmo001/kestrel#7).
 */
import {
  coreThemeChoices,
  optionalThemeChoices,
} from "@timmo001/groundwork-tokens/page";

export const themeSettings = {
  key: "kestrel:theme",
  defaultTheme: "base",
} as const;

/** Base first, then the other core themes, then the optional ones by family. */
export const themes = [
  ...coreThemeChoices.filter(({ id }) => id === themeSettings.defaultTheme),
  ...coreThemeChoices.filter(({ id }) => id !== themeSettings.defaultTheme),
  ...optionalThemeChoices,
];
