---
title: Agents
description: The kestrel CLI, its Code Mode manifest and MCP server, and the skill that tells an agent how to use them.
---

The `kestrel` CLI in `packages/cli` reads your cameras through the server's
[API](/api). Every command that prints takes `--json`. They only read from the sources;
`download` also writes the file it saves, and `pair` saves the CLI's token.

| Command                                                | Returns                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `kestrel status`                                       | What needs you, each source's connection and its state      |
| `kestrel details -s <source>`                          | A source's facts, clock, storage and each camera's state    |
| `kestrel sources`                                      | Each source's settings and camera names, with no secrets    |
| `kestrel cameras`                                      | Each camera's id, name and what it can do                   |
| `kestrel recordings -c swann/1 -d <day>`               | A camera's recordings on one day, today by default          |
| `kestrel download -c swann/1 -d <day> --from … --to …` | Saves that stretch as an MP4, across recordings             |
| `kestrel days -m <month>`                              | The days with recordings in a month, this month by default  |
| `kestrel events`                                       | The newest events                                           |
| `kestrel devices`                                      | The devices paired with the server                          |
| `kestrel devices remove <id>`                          | Unpairs a device                                            |
| `kestrel jobs`                                         | What the server does by itself, and how each is getting on  |
| `kestrel usage`                                        | The server's memory, CPU and disk use against its limits    |
| `kestrel backups`                                      | The backups kept on the server                              |
| `kestrel backups make`                                 | Downloads a backup here, or keeps one on the server         |
| `kestrel backups get <name>`                           | Downloads a backup kept on the server                       |
| `kestrel backups remove <name>`                        | Deletes a backup kept on the server                         |
| `kestrel backups restore <file or name>`               | Restores a backup, and the server starts again              |
| `kestrel pair`                                         | A one-time code and QR code for another device              |
| `kestrel pair --remote`                                | The same, at the server's outside address                   |
| `kestrel pair <code> --server <address>`               | Pairs this CLI with a server                                |
| `kestrel config copy --server <address>`               | Copies this machine's sources to another server             |
| `kestrel servers`                                      | The Kestrel servers on this network, found over mDNS        |
| `kestrel serve`                                        | Runs the server with no window; see [Running it](/running)  |
| `kestrel agent tools --json`                           | The Code Mode manifest; see below                           |
| `kestrel agent call <tool>`                            | Runs one tool with its input as JSON on stdin               |
| `kestrel mcp`                                          | Serves the read-only tools over MCP on stdio                |

`-c` takes a camera's id, such as `swann/1`; while there's one source, its
camera's own id, such as `1`, is enough. `details` shows the only source
with details unless `-s` names one. `download` takes times of day on
`--date`, such as `21:46` or `21:46:30`, or full ones such as
`2026-11-11T21:46:30`. `--sub` saves the small sub stream, and `-o` names the
file; by default it's named after the camera and start.

`backups make` downloads the backup to this folder, or with `--keep` makes
it in the server's backups folder. Recordings go in unless
`--no-recordings` leaves them out; `--camera`, given once for each, keeps
to some cameras, and `--from` and `--to` to some days. `--lock` locks it
with a passphrase. `backups restore` takes a backup file here, or the name
of one kept on the server, and keeps the server's recordings beside the
backup's unless `--replace` deletes them first. A passphrase never goes on
the command line: it comes from `KESTREL_BACKUP_PASSPHRASE`, or is typed
in when that's not set. See [Backups](/running#backups) for what a backup
holds.

It talks to `KESTREL_SERVER` with the token in `KESTREL_TOKEN` where
they're set. Otherwise it uses the server and token `kestrel pair` saved
in `client.json` in the config folder, readable only by you. Otherwise it
talks to this machine's own server at `http://127.0.0.1:7380`, signing in
with the owner token in the state folder when it can read it. A server
answers only devices paired with it, so pair the CLI first: get a code
from Settings, Devices on a paired browser, then run
`kestrel pair <code> --server <address>`. Servers announce themselves on
the network, so `--server` can be left out while there's only one, and
`kestrel servers` lists them. When a paired server moves to a new address,
the CLI finds it again by its id and keeps the new address. With no code, `kestrel pair`
on the server shows a code and QR code for another device; for a server
running as its own user, run it as that user, such as
`sudo -u kestrel kestrel pair`.

Run it from the repository with `bun packages/cli/src/cli.ts`.

## Code Mode and MCP

`kestrel agent tools --json` prints the Code Mode manifest: every tool, its
input as JSON Schema and whether it reads or writes, and
`kestrel agent call <tool>` runs one with its input as JSON on stdin,
printing what the command prints with `--json`. `download`, `pair`,
`config_copy` and the `backup_` tools are the writes, since they save a
file, a token, another server's settings or a backup, or restore one.
`kestrel mcp` serves the other operations over MCP on
stdio, as read-only tools; a video file means nothing in an MCP reply, and
pairing, copying and backups are for a person to do, so those stay out of
it, apart from `backups`, which lists them.

## OpenCode

The plugin in `opencode-plugin/` turns the manifest into the `kestrel` Code
Mode namespace, running each tool through the `kestrel` command on the
`PATH`, so its tools always match the installed version. Writes ask first:
`download` once for each camera, unless you always allow it, and `pair`,
`config_copy`, `backup_make`, `backup_remove` and `backup_restore` every
time. Add it to OpenCode's config:

```json
{
  "plugins": ["github:timmo001/kestrel#main::path:opencode-plugin"]
}
```

## The skill

`skills/kestrel/SKILL.md` tells an agent to use Code Mode first, then MCP,
then the CLI, and how to read what comes back: start from `status`, and look
for PIR and motion recordings when no events have come in.
