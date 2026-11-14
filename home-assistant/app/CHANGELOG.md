Web pages sources no longer warn about YouTube pages when the server has no Deno or Node.js, since YouTube's live streams play without one.

## Sources

- A Web pages source with YouTube pages no longer lists a notice asking for Deno or Node.js. yt-dlp reads YouTube's live streams without a JavaScript runtime today, including in the Home Assistant app.
- yt-dlp may come to need one for YouTube's live streams. If YouTube pages stop playing, put Deno or Node.js on the server's path; the docs say so too.
