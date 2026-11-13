Kestrel can now change each Raysharp camera's picture: hue, brightness, contrast, saturation and sharpness, from the Live page.

## App

- Live has a Picture button beside Move (or press **P**) for the picked camera, where it has picture settings. It opens sliders for hue, brightness, contrast, saturation and sharpness, and the picture changes as you drag.
- Reset puts a camera's picture back to its defaults.

## Sources

- Raysharp recorders, such as the Swann DVR8-4575, offer picture settings on every channel. A change applies at once and stays on the recorder, as one made on the recorder itself would.

## API

- `GET /api/cameras/:source/:camera/picture` reads a camera's picture settings, each from 0 to 1, and `POST` on the same route changes them or puts back the defaults.
- Each camera's `controls.picture` in `/api/cameras` says which settings it has and whether it can reset them.
