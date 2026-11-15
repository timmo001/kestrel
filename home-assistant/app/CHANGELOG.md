## Fixes

- Front Door recordings where the camera mixed a second, smaller picture into the main one now play cleanly. The server drops the stray frames as it reads each file, without re-encoding, and the player says so on the tile; the recordings table marks these clips as repaired (timmo001/kestrel#30).
