Reolink cameras that send their clips to Kestrel now find it by name, and pages that need JavaScript to read play out of the box.

## Sources

- When **Send clips to Kestrel** is turned on, a Reolink camera is now given the server's name on your network, such as `homeassistant`, instead of its address, so it still finds Kestrel if that address changes. Where the network has no name for it, the camera is given the address as before. A camera already sending to the address still shows as sending.
- The desktop app, the release archives, the Linux packages, the container images and the Home Assistant app now bring their own Node.js. yt-dlp uses it for sites it reads with JavaScript, such as YouTube, so those pages keep playing without installing anything else. Elsewhere, `KESTREL_NODE` names the one to use.
