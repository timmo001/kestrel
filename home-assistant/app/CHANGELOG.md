On a Home Assistant Green, 0.4.0 still ran out of memory once it reached the Reolink hub's recordings. Converting them has its own limits now, and new motion clips no longer wait behind a long copy.

## Converting recordings

The Reolink hub records in 4K H.265, which Kestrel converts to H.264 as it copies. In 0.4.0, ffmpeg used every core with x264's full lookahead and held dozens of 4K frames at once: 2.5 GB on an 8-core laptop, and about 1 GB on the Green, before the limits could step in. The whole replay was also held in memory before conversion started.

- Replays go to disk as they arrive, at the copy rate, and wait on the same limits as any other copy.
- Background conversions run ffmpeg on one thread with a short lookahead, and wait for room before they start. A 4K hub clip now converts in about 400 MB, where 0.4.0 took 2.5 GB.
- Playing a clip that isn't copied yet converts on up to four threads, so it still starts quickly.
- Bambu Lab footage converts the same way.

Hub clips convert slowly on a Green, several minutes each, but they no longer take it down.

## Recent clips first

Motion clips were already copied newest first, but each pass worked through the whole list it started with. On a first run that can be thousands of files, so new motion waited hours. A copy now looks again every 10 minutes, so new clips go ahead of older ones still waiting.

## Docs

- The install docs are in one place, with a tab for each platform.
