Kestrel now keeps to limits when it works in the background, so it can share a small machine, such as a Home Assistant Green, with everything else on it. An Activity page shows what it's doing and how much it uses.

## Limits on background work

On a Home Assistant Green, 0.3.0 copied every recorder recording at full speed. It grew to 700 MB and pushed the box into swap. Now copying recordings from sources, and clearing out old ones, wait while:

- under 15% of the machine's memory is free,
- the server, go2rtc and ffmpeg use over 512 MB together,
- they use over half the machine's CPU over half a minute,
- or the machine is short of memory (swapping) or its disks are busy, from Linux's pressure figures.

Copies also read no faster than 2 MB a second. Change the limits in Settings, Recording, Background work. Live view and the server's own recording never wait. Clearing out waits at most 10 minutes, then runs anyway, as it frees the disk.

## Activity

- A new **Activity** page lists each job: the copy from sources, each camera's recording and the clear-out. For each one it shows what it's doing, how far through it is, its last run and its last error, plus the recordings copied lately.
- The page also shows the server's memory and CPU against the limits, the machine's memory and load with the last hour of each, and what each camera's recordings take on disk. It says why background work is waiting when it is.
- `kestrel jobs` and `kestrel usage` print the same, with `--json`, and they're MCP tools too. The API has them at `/api/activity/jobs` and `/api/activity/usage`.

## Packages

- The systemd services run at a lower CPU and disk priority.
- The Home Assistant app gets 30 seconds to stop, so each camera's recording finishes its file.

## Fixes

- A new server no longer warns every hour that old recordings couldn't be cleared out before anything has been recorded.
- The `kestrel` command no longer reads a `.env` file or `bunfig.toml` from the folder it's run in. A project's settings there can't change what it sends to a server, such as `kestrel config copy` picking up another login.
