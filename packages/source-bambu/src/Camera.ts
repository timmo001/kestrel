/**
 * The camera feed Bambu Lab P1 and A1 printers serve over TLS on port
 * 6000, following the open-source ha-bambulab client: an 80-byte login
 * with the printer's access code, then a JPEG picture every second or two,
 * each after a 16-byte header that starts with its size.
 *
 * @module
 */

/** The port the camera feed is served on. */
export const cameraPort = 6000;

const headerSize = 16;

/** A picture bigger than this means the feed is out of step. */
const largestPicture = 8 * 1024 ** 2;

const encoder = new TextEncoder();

/**
 * The login that opens the feed: four little-endian words (0x40, 0x3000, 0
 * and 0), then the username `bblp` and the access code, each padded to 32
 * bytes.
 */
export const loginPacket = (accessCode: string) => {
  const packet = new Uint8Array(80);
  const view = new DataView(packet.buffer);

  view.setUint32(0, 0x40, true);
  view.setUint32(4, 0x3000, true);
  packet.set(encoder.encode("bblp"), 16);
  packet.set(encoder.encode(accessCode).subarray(0, 32), 48);

  return packet;
};

const isJpeg = (picture: Uint8Array) =>
  picture[0] === 0xff &&
  picture[1] === 0xd8 &&
  picture.at(-2) === 0xff &&
  picture.at(-1) === 0xd9;

export interface Pictures {
  readonly pictures: ReadonlyArray<Uint8Array>;
  /** Why the feed can't be read any further, such as a header out of step. */
  readonly problem: string | null;
}

/** Reads whole pictures out of the feed's bytes, however they're split as they arrive. */
export const pictureReader = () => {
  let buffer = new Uint8Array(0);

  return (chunk: Uint8Array): Pictures => {
    const joined = new Uint8Array(buffer.length + chunk.length);

    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;

    const pictures: Array<Uint8Array> = [];

    while (buffer.length >= headerSize) {
      const size = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ).getUint32(0, true);

      if (size > largestPicture) {
        return { pictures, problem: `sent a picture header for ${size} bytes` };
      }

      if (buffer.length < headerSize + size) break;

      const picture = buffer.slice(headerSize, headerSize + size);

      buffer = buffer.slice(headerSize + size);

      if (!isJpeg(picture)) {
        return { pictures, problem: "sent a picture that isn't a JPEG" };
      }

      pictures.push(picture);
    }

    return { pictures, problem: null };
  };
};
