/**
 * What Kestrel's page asks the main process for, beside Groundwork's desktop
 * requests.
 */

export type AppRequests = {
  /** Where the docs built into the app are served. */
  readonly docs: () => Promise<string>;
};
