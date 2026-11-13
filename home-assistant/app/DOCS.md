# Kestrel

Runs the Kestrel server: your cameras, recordings and events in one place, from Raysharp-made recorders such as Swann's, Reolink cameras and hubs, Bambu Lab printers and any camera with a stream address. Every other device, such as the desktop app, a browser or the `kestrel` command, uses this server, so there's one copy of the footage.

The full documentation is at [kestrel.timmo.dev](https://kestrel.timmo.dev), including [this app](https://kestrel.timmo.dev/running/#home-assistant) and [installing Kestrel](https://kestrel.timmo.dev/install/) on your other devices.

## Setting up

1. Start the app and open **Kestrel** in the sidebar. Home Assistant has already signed you in, so it needs no pairing.
2. In **Settings**, add your recorders and cameras. Or, from a computer that already has them set up, pair it as below and copy its settings across with `kestrel config copy --server http://homeassistant.local:7380`.

## Other devices

The server also listens on port 7380 of Home Assistant's own address, and announces itself on the network, so other devices find it. Each device pairs once, with a code:

- A browser: open `http://homeassistant.local:7380` and type the code from **Settings > Devices**, or scan its QR code with a phone.
- The desktop app: choose **Use another server…** in its tray menu and pick this one.
- The `kestrel` command: `kestrel pair <code>`.

Remove a device in **Settings > Devices** and it's signed out at once.

The server speaks plain HTTP, so a paired device's sign-in is only as private as your network. Version for version, every device must run the same Kestrel as this app, and says how to update when it doesn't.

## The sidebar

Kestrel takes the whole screen: Home Assistant hides its sidebar and header while it's open. Select the menu button at the start of the app bar to show the sidebar again; on a phone, it's in the app bar's menu instead. To keep the sidebar, turn off the `hide_sidebar` option.

## Recordings

Recordings Kestrel makes itself, and copies of recordings from your recorders and cameras, are kept in Home Assistant's media folder, under `kestrel`, so they show in its media browser. Settings and paired devices are kept in the app's own data.
