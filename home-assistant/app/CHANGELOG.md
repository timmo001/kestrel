Kestrel's web app now uses Groundwork's shared pieces for installing and updating, rather than its own copies. Nothing should look different, apart from a few details below.

## Web app

- The banner offering to install Kestrel as an app is now Groundwork's install banner. If you turned it down before, it stays turned down.
- When the server is updated, an open page moves onto the new version through Groundwork's update helper, just as before: it reloads once by itself, and if that doesn't help it shows the Reload banner.
- The service worker's cache version now comes from what's in the build, so a release that changes nothing in the page doesn't throw away the offline copy.

## Server

- Built files with a content hash in their name, such as fonts and other assets, are now kept by the browser for a year rather than checked on every load, so pages load faster. The page, its script, the service worker, the manifest and icons are still checked every time.
- The check that a page or the CLI is on the server's version now uses Groundwork's, and keeps Kestrel's message saying which side to update and how.

## Updates

- Updates Effect, Bun, Electrobun, mediabunny, Groundwork 0.51.1 and other dependencies.
