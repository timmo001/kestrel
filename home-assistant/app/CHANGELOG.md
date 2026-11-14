Web page cameras start sooner, and you can now turn a source or a single camera off in Settings without removing it.

## Settings

- Each source has a switch on its panel that turns it off. The server keeps its settings but doesn't start it, and its panel says "Off". Turn it back on and save to start it again.
- Each camera has a switch beside its name, under its source, that turns that one camera off. It keeps its name and its recordings, but has no live video or still and isn't recorded. This works for any source, so one page of a web page source can be turned off while the others play.
- `sources.json` only says so when something's off: `"enabled": false` on a source, and an `off` list of cameras.

## Live

- Web page cameras now start in the order you gave your cameras, two at a time, rather than all at once. Each one has to be looked up afresh when it starts, and starting them all together slowed every one down, so the first ones now show sooner. Other cameras start at once, as before.

## Sources

- Web page sources start faster. Kestrel now carries yt-dlp unpacked, rather than as a single file that unpacks itself every time it runs. On the Home Assistant Green one page now takes about 6 seconds to start rather than 7 or 8, and four at once about 10 rather than 15.

## CLI

- `kestrel cameras` marks a camera that's turned off with "off", and `kestrel sources` lists the cameras turned off. `kestrel config copy` carries them over too.
