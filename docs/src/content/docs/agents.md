---
title: Agents
description: The dvr-revival CLI, its Code Mode manifest and MCP server, and the skill that tells an agent how to use them.
---

The `dvr-revival` CLI in `packages/cli` reads the recorder through the
server's [API](/api). Every command takes `--json`, and all of them only read.

| Command                                 | Returns                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| `dvr-revival status`                    | The connection, the recorder's clock, disks and channels      |
| `dvr-revival device`                    | Its name, firmware and channel count                          |
| `dvr-revival recordings -c 1 -d <day>`  | A channel's recordings on one day, today by default           |
| `dvr-revival days -m <month>`           | The days with recordings in a month, this month by default    |
| `dvr-revival events`                    | The newest alarm reports                                      |
| `dvr-revival video`                     | Where go2rtc is served, and each channel's stream names       |

It talks to `DVR_REVIVAL_SERVER`, `http://127.0.0.1:7380` by default. Run it
from the repository with `bun packages/cli/src/cli.ts`.

## Code Mode and MCP

`dvr-revival agent tools --json` prints the Code Mode manifest: every
operation, its access and the command behind it. `dvr-revival mcp` serves the
same operations over MCP on stdio, as read-only tools.

## The skill

`skills/dvr-revival/SKILL.md` tells an agent to use Code Mode first, then MCP,
then the CLI, and how to read what comes back: start from `status`, and look
for PIR and motion recordings when no alarm reports have come in.
