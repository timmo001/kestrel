Reolink hub clips are no longer converted. They're kept in H.265 as the hub recorded them, which is what took a Home Assistant Green to the edge in 0.4.x. There's also an Activity page to see what Kestrel is doing and what it's allowed to use.

## H.265 kept as it is

The hub records in 4K H.265. Up to 0.4.1, Kestrel converted every clip to H.264 as it copied, and one 4K conversion could hold about 500 MB and a core and a half on a Green for twenty minutes.

- Hub clips go into an MP4 as they are, with no conversion, so copying is mostly disk work now.
- The Recordings page plays H.265 where the browser can, which includes Chrome, Edge and Safari. Where it can't, it says so; download the clip to play it in another player.
- Playing across a camera's older H.264 clips and newer H.265 ones switches between them as it goes.
- Bambu Lab footage is MJPEG, so it's still converted, at the lowest priority.

## Activity

- Memory, CPU, disk and copy rate each show what's used against what background work is allowed, with the allowance drawn on the graph. They turn amber past it.
- Errors and job runs go to an activity log, kept for 7 days, with tables for errors, recent copies and jobs.
- Every table has a quick search, filters and a date and time filter, all remembered.

## Agents

- An OpenCode plugin for the `kestrel` Code Mode tools, and `kestrel agent call` to run them from the command line.
