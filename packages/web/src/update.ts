/**
 * Moving the page onto a new release. The server refuses a page from another
 * version, so once it does, the service worker checks for the new build,
 * which keeps its files and takes over by itself, and the page reloads onto
 * them. Without a worker, such as over plain HTTP on the network, the reload
 * fetches them itself.
 */
import type { Pwa } from "@timmo001/groundwork-pwa/view";

/** How long a new worker gets to take over before the page reloads anyway. */
const takeOverTimeout = 10_000;

/** Reloads the page onto the server's release, once the worker has it. */
export const reloadForUpdate = async (pwa: Pwa) => {
  const registration = await pwa.worker;

  if (
    registration !== undefined &&
    navigator.serviceWorker.controller !== null
  ) {
    const takenOver = new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () =>
        resolve(),
      );
      setTimeout(resolve, takeOverTimeout);
    });

    await registration.update().catch(() => undefined);

    if (registration.installing !== null || registration.waiting !== null) {
      await takenOver;
    }
  }

  location.reload();
};
