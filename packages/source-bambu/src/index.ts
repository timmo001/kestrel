/**
 * Bambu Lab printers, as a Kestrel source: the camera on a P1 or A1, as a
 * picture every few seconds over the printer's own network feed, with the
 * footage and timelapses it keeps on its storage.
 *
 * @module
 */
import type { Kind } from "@timmo001/kestrel-core";
import { info, make } from "./Source.ts";

/** The `bambu` kind of source. */
export const kind: Kind = { info, make };
