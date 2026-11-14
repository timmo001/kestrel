Watching several cameras at speed now holds together: when one camera can't keep up, the others wait for it rather than running on, and a camera that keeps falling behind switches to key frames so everyone can carry on. On a phone held sideways, and in full screen, the player's controls now sit over the picture and fade away like a video player's. The day picker has moved onto the timeline.

## Recordings

- Several cameras at speed stay together. While one camera loads, the others pause and wait for it, then play on together. Previously the camera being waited for kept playing on its own and ran far ahead of the clock.
- A camera that keeps running out of video at 4× or faster, such as a large-picture doorbell, switches to key frames only, so it keeps up instead of holding everyone up. Past 16× it takes one key frame per two seconds of footage. Changing speed tries the full video again.
- Click another camera to pick it. The tiles stay where they are, so a double click shows the camera you clicked on its own, as on Live.
- The row of day buttons is gone. Previous day, the date picker and Next day now sit at the start of the timeline's footer, and they stay with the timeline in full screen.
- Recordings only asks for a camera's small sub stream when some of what's playing is still only on the camera. Kestrel's own copies are always full size.

## Player controls

- On a phone held sideways, and in full screen, the controls sit over the bottom of the picture on a see-through background, as a video player's do. They fade out after about three seconds of playing untouched. A tap on the picture, or moving the mouse, brings them back, and that tap does nothing else. They stay up while paused.
- On a phone held sideways, the controls show one row: the time, previous, play, next, View and full screen. A tab on the bar's top edge opens the speeds and zoom.
- Turning a phone sideways takes the player full screen, where the browser allows it, and turning it back upright leaves.
- On Recordings on a phone held sideways, the player fills the screen, with the cameras and the timeline below it.
- The control bar no longer gets stuck in the phone layout on a wide window. Between one row and the phone layout there's now a two-row step, with play and its neighbours across the top, and Next frame sits with them.

## Fixes

- Several cameras at speed no longer stretch the picture: Kestrel's own copies are drawn at their own shape. Only a recorder's squeezed sub stream is stretched back out.
- A camera reaching the end of a short recording no longer starts it again from the beginning, which could hold the others for seconds at a time or send the clock back.
- The Play and Pause button now updates straight away while one camera is waiting for another.
