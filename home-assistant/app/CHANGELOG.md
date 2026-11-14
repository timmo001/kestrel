Reolink cameras can now send their clips straight to Kestrel, so a clip that was only on a camera's SD card can be played.

## Sources

- A Reolink camera on its own has a **Send clips to Kestrel** switch on its source in Settings. Turning it on points the camera's FTP uploads at Kestrel, with a login Kestrel makes for that source, and runs the camera's own test where it has one, showing what it said. Turning it off stops the camera sending.
- Each clip the camera sends when it sees motion is kept in the recordings folder as a motion clip, for the clip hours set under Recording, and plays and downloads like any other. It takes the place of the faded "on the source only" entry for the same clip.
- A Home Hub or recorder doesn't have the switch, since Kestrel already copies its recordings itself.

## Server

- The server takes clips on port 7381, with data on ports 7390 to 7399, on the address it listens on. `KESTREL_FTP_PORT` changes the first. The Home Assistant app shares the host's network, so it needs nothing more; a Docker container needs the host's network for cameras to reach it.
- The receiver only takes files in: it lists nothing, hands nothing back and deletes nothing, and each source's login only works for that source.
