Live can show a single camera, or a few, from its address, and there's a new embed page for putting live cameras on a dashboard or in a window of their own, with each of its controls left in or out.

## Live

- Live takes `camera` and `cameras` in its address, as Recordings does: `/?camera=swann/1` shows that camera alone, and `/?cameras=swann/1,swann/3` those cameras in that order, with `camera` picking one of them.
- Showing cameras from the address doesn't change where Live is left for next time. Going back to Live from the app bar brings back the layout, page and picked camera from before.

## Embed

- `/embed` is Live on its own, with no app bar, banners or page around it, filling the frame or window edge to edge. It takes `camera` and `cameras` as Live does.
- Every control is there until `hide` leaves some out, as a comma list: `controls` (the whole bar), `caption` (each camera's name), `layout`, `pause`, `sound`, `zoom`, `lens` (a second view in the corner), `picture`, `move`, `capture`, `help` and `fullscreen`. Leaving one out turns off its keys and gestures too. `hide=all` leaves out every one, for the plain video, such as `/embed?camera=swann/1&hide=all`.
- An embed keeps nothing in the browser, so changing its layout, zoom or sound never changes the app's.
- A browser that isn't paired yet pairs in the embed, and goes back to it once it is. Pairing from any other page also goes back to where it was sent from.
- Give an iframe `allow="fullscreen"` for its full screen button to work.

## Other changes

- Groundwork's packages are updated to 0.51.0, and the shared lint rules to 0.7.1.
