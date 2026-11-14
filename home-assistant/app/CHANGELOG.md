Reloading Kestrel is quicker: Live starts its cameras straight away, and the server stops asking the recorder the same things again and again.

## Live

- The browser keeps the last list of cameras, so after a reload Live starts its players at once, before the server answers. They only start again if the server's list turns out different. Live also no longer waits on each source's details before starting.
- When a page stops watching a camera, Kestrel holds its stream open for another 30 seconds. A page loading again in that time finds the camera already connected, which cut the main stream's first picture from about a second to a fifth of one on a Swann recorder.

## Server

- What a source answers is kept for a while, so several pages, or one loading again, don't each ask it again: its cameras and details for 10 seconds, and today's recordings for 15. Recordings of past days and months are kept for 10 minutes, since only the recorder clearing out old footage changes them. Failures are never kept, and saving a source's settings starts it with nothing kept.
