One Kestrel server now serves every device, and Kestrel installs almost anywhere.

- Devices pair with the server once, with a code or a QR code from Settings, Devices, and only paired devices see the cameras. Remove one there and it's signed out at once.
- Servers announce themselves on the network, so the desktop app and `kestrel servers` find them, and find a paired one again when its address changes.
- The desktop app can use another server, such as the Home Assistant app, or share its own with other devices: see Use another server… and Share with other devices in the tray.
- The server and every client run the same version. When they don't, each says which side to update and how; on Windows the app updates itself to match.
- `kestrel serve` runs the server with no window, and `kestrel config copy` moves your sources and recording settings to another server.
- New ways to install: `kestrel-nvr-bin` in the timmo pacman repository and the AUR, `.deb` and `.rpm` for x86_64 and aarch64, the `ghcr.io/timmo001/kestrel` container, and a Home Assistant app in timmo001/home-assistant-apps. Each package has a user service and a system service for `kestrel serve`.
- The release archives are now `kestrel-nvr-<version>-<platform>`, and the Setup files `Kestrel-Setup-<version>-<platform>`.
- The docs have a new Install page, and Running it covers the ways to run a server and pairing.
