Kestrel can back itself up and restore, with everything in: settings and logins, the server's id, paired devices and recordings. Restoring onto a new machine brings the server back as it was, with the devices you'd paired still paired.

## Backups

- The Settings page has a Backups panel. Make a backup with every camera's recordings (the default), none, or only some cameras or days, then download it or keep it on the server.
- A backup can be locked with a passphrase. It holds your sources' logins, so lock it unless it's kept somewhere only you can read. A locked one is encrypted with AES-256-GCM, and there's no way to get a lost passphrase back.
- A backup is made as it's downloaded, so the download starts straight away, however many recordings it holds.
- Backups kept on the server are listed to download, restore or delete. Copy the ones you keep somewhere else too, so they outlast the machine.
- Kestrel only makes backups when you ask; there's no schedule.

## Restoring

- Restore a backup kept on the server, or upload one, from the Backups panel. The upload shows its progress, and the page loads again once the server's back.
- Recordings already on the server are kept beside the backup's by default, or replaced, which deletes only Kestrel's own camera folders first.
- The backup is read and checked in full before anything changes, so a wrong passphrase or a damaged file leaves the server as it was. The server then starts again and puts it in place before it reads anything.
- Where the backup's recordings folder isn't on this machine, its recordings go in this server's own folder.
- A backup or restore shows on the Activity page while it runs, and only one runs at a time.

## Home Assistant

- A Home Assistant backup of the app only takes recordings when it includes Media, as they're in the media folder. A Kestrel backup takes both.
- Backups kept in the app are left out of Home Assistant's backups of it, as they're copies already.
- Large uploads through the sidebar are streamed to the app, rather than held in memory on the way.

## CLI and agents

- `kestrel backups` lists the backups on the server, and `kestrel backups make`, `get`, `remove` and `restore` do the rest, with `--no-recordings`, `--camera`, `--from`, `--to`, `--lock`, `--keep` and `--replace`. The passphrase comes from `KESTREL_BACKUP_PASSPHRASE` or is typed in, never on the command line.
- The `backups` tool lists them in Code Mode and MCP, and `backup_make`, `backup_get`, `backup_remove` and `backup_restore` are Code Mode writes. Making, deleting and restoring always ask first.
