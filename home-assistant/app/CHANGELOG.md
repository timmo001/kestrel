Kestrel can now show live streams from web pages, such as a Twitch channel or a YouTube live stream, beside your own cameras.

## Sources

- A new **Web pages** source takes a list of pages, each with an id, a name and its address: a Twitch channel, a YouTube live stream, or any other page yt-dlp can read. Only `http://` and `https://` addresses are taken.
- Each page's stream is found as it starts, and again when it reconnects, since a site's stream addresses soon run out. A web camera takes a few seconds longer to start than one on your network.
- They're live view only: no recordings, events or stills.
- YouTube needs Deno or Node.js on the server's path for yt-dlp to read its streams. Kestrel doesn't bring one, and the Home Assistant app has neither, so YouTube pages may not play there. Twitch and most other sites need nothing extra.
- Keep to each site's terms: some don't allow their streams to be shown elsewhere, and Twitch's ads play in the stream as they would on its page.

## Server

- The desktop app, the release archives, the Arch, Debian and RPM packages and the container images now include [yt-dlp](https://github.com/yt-dlp/yt-dlp). Set `KESTREL_YT_DLP` to use another.
- go2rtc now uses the ffmpeg `KESTREL_FFMPEG` names, the same one recording uses, for the streams it copies.
