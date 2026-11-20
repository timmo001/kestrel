Pairing links can now point at the server's outside address, for a device away from home.

## Pairing

- A new setting, `KESTREL_REMOTE_URL`, is the address devices outside your network reach the server at, through a reverse proxy with HTTPS.
- With it set, `kestrel pair --remote` shows the pairing link and QR code at that address instead of the home one. Without it, it says to set it and makes no code.
- Pairing codes from the API carry `remoteLink` beside `link`.
