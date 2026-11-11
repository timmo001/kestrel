/**
 * The page's theme settings, shared by the boot script the build inlines and
 * the page. Base only until the app's own themes are chosen
 * (timmo001/dvr-revival#7).
 */
export const themeOptions = {
  key: "dvr-revival:theme",
  defaultTheme: "base",
} as const;
