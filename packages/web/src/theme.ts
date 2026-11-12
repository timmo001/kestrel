/**
 * The page's theme settings, shared by the boot script the build inlines and
 * the page: Kestrel's own theme first and by default, then every Groundwork
 * theme and mode, with nothing to import. The build solves Kestrel's theme
 * from `kestrel.theme.json` and puts its CSS on the page.
 */
import {
  coreThemeChoices,
  optionalThemeChoices,
  themeOptions,
  type ThemeChoice,
} from "@timmo001/groundwork-tokens/page";
import { Result } from "effect";
import kestrelTheme from "./kestrel.theme.json";

export const themeSettings = {
  key: "kestrel:theme",
  defaultTheme: kestrelTheme.id,
} as const;

/** Kestrel's own theme, the first choice. */
const own: ReadonlyArray<ThemeChoice> = [
  { id: kestrelTheme.id, name: kestrelTheme.name },
];

/** Kestrel's theme, then the core themes, then the optional ones by family. */
export const themes = [...own, ...coreThemeChoices, ...optionalThemeChoices];

/** The picker's options: Kestrel's theme on its own at the top, then Groundwork's by group. */
export const pickerOptions = [
  ...themeOptions(own, ""),
  ...themeOptions([...coreThemeChoices, ...optionalThemeChoices]),
];

/**
 * Every theme's document, for agents choosing one through the theme tools:
 * Kestrel's, then the core ones. Loaded only when the tools register.
 */
export const themeDocuments = async () => {
  const [{ coreThemes }, { parseTheme }] = await Promise.all([
    import("@timmo001/groundwork-tokens/webmcp"),
    import("@timmo001/groundwork-tokens/runtime"),
  ]);

  const own = parseTheme(JSON.stringify(kestrelTheme));

  return Result.isSuccess(own) ? [own.success, ...coreThemes] : coreThemes;
};
