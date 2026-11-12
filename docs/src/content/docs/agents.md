---
title: Agents
description: The kestrel CLI, its Code Mode manifest and MCP server, and the skill that tells an agent how to use them.
---

The `kestrel` CLI in `packages/cli` reads the recorder through the
server's [API](/api). Every command takes `--json`. They only read from the
recorder; `download` also writes the file it saves.

| Command                                          | Returns                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `kestrel status`                                 | The connection, the recorder's clock, disks and channels   |
| `kestrel device`                                 | Its name, firmware and channel count                       |
| `kestrel recordings -c 1 -d <day>`               | A channel's recordings on one day, today by default        |
| `kestrel download -c 1 -d <day> --from … --to …` | Saves that stretch as an MP4, across recordings            |
| `kestrel days -m <month>`                        | The days with recordings in a month, this month by default |
| `kestrel events`                                 | The newest alarm reports                                   |
| `kestrel video`                                  | Where go2rtc is served, and each channel's stream names    |

`download` takes times of day on `--date`, such as `21:46` or `21:46:30`, or
full ones such as `2026-11-11T21:46:30`. `--sub` saves the small sub stream,
and `-o` names the file; by default it's named after the channel and start.

It talks to `KESTREL_SERVER`, `http://127.0.0.1:7380` by default. Run it
from the repository with `bun packages/cli/src/cli.ts`.

## Code Mode and MCP

`kestrel agent tools --json` prints the Code Mode manifest: every
operation, its access and the command behind it. `download` is the one
`write`, since it saves a file. `kestrel mcp` serves the other operations
over MCP on stdio, as read-only tools; a video file means nothing in an MCP
reply, so `download` stays in the CLI.

## The skill

`skills/kestrel/SKILL.md` tells an agent to use Code Mode first, then MCP,
then the CLI, and how to read what comes back: start from `status`, and look
for PIR and motion recordings when no alarm reports have come in.
