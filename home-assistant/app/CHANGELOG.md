Recordings keeps up with today: the newest recording runs on up to now, as the recorder's own client shows it, and full screen keeps the day's timeline under the picture.

## Recordings

- Full screen now takes the video, its controls and the day's timeline together, so you can see the day and click to another time without leaving full screen. A clip marked with Cut shows on it too. The day and camera pickers stay out of the way.
- On today, the list is read again every 30 seconds while the page is open, so a camera recording all the time has its newest recording running on up to now, on the timeline and in the table, rather than stopping where it was when the page opened.
- Playing on into the newest recording carries on past where it ended when the page opened, rather than stopping there.

## Updates

- An open page moves onto a new release by itself: the service worker picks up the new build and takes over, and the page reloads onto it. The page's script and styles come from the network first, so a new release never starts with the last one's bundle.
