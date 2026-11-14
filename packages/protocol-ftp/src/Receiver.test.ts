/** Drives the receiver as a camera would: logs in, opens a passive data connection and stores a file. */
import { describe, expect, test } from "bun:test";
import { connect, type Socket as NetSocket } from "node:net";
import { Effect, Redacted, Stream } from "effect";
import { parse, resolve, serve, type Upload } from "./Receiver.ts";

/** A plain FTP client's control connection, reading replies a line at a time. */
const client = async (port: number) => {
  const socket = connect({ port, host: "127.0.0.1" });
  const lines: Array<string> = [];
  const waiting: Array<(line: string) => void> = [];
  let buffered = "";

  socket.on("data", (chunk) => {
    buffered += chunk.toString();

    for (;;) {
      const end = buffered.indexOf("\r\n");

      if (end === -1) break;

      const line = buffered.slice(0, end);

      buffered = buffered.slice(end + 2);

      const next = waiting.shift();

      if (next === undefined) lines.push(line);
      else next(line);
    }
  });

  const read = () =>
    new Promise<string>((done) => {
      const line = lines.shift();

      if (line === undefined) waiting.push(done);
      else done(line);
    });

  const send = async (line: string) => {
    socket.write(`${line}\r\n`);

    return await read();
  };

  await new Promise<void>((done) => socket.once("connect", () => done()));

  return { socket, read, send };
};

const write = (socket: NetSocket, data: string) =>
  new Promise<void>((done) => socket.end(data, () => done()));

describe("receiver", () => {
  test("stores a file sent over a passive connection", async () => {
    const received: Array<{ upload: Upload; text: string }> = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const receiver = yield* serve({
            port: 0,
            host: "127.0.0.1",
            passive: { from: 47390, to: 47399 },
            check: (user, password) =>
              Effect.succeed(
                user === "camera" && Redacted.value(password) === "secret",
              ),
            receive: (upload) =>
              upload.data.pipe(
                Stream.decodeText(),
                Stream.mkString,
                Effect.map((text) => {
                  received.push({ upload, text });
                }),
              ),
          });

          yield* Effect.promise(async () => {
            const ftp = await client(receiver.port);

            expect(await ftp.read()).toStartWith("220");
            expect(await ftp.send("STOR early.txt")).toStartWith("530");
            expect(await ftp.send("USER camera")).toStartWith("331");
            expect(await ftp.send("PASS wrong")).toStartWith("530");
            expect(await ftp.send("USER camera")).toStartWith("331");
            expect(await ftp.send("PASS secret")).toStartWith("230");
            expect(await ftp.send("TYPE I")).toStartWith("200");
            expect(await ftp.send("MKD clips")).toBe('257 "/clips" made');
            expect(await ftp.send("CWD clips")).toStartWith("250");
            expect(await ftp.send("PWD")).toBe('257 "/clips"');

            const passive = await ftp.send("PASV");
            const numbers = /\((.+)\)/.exec(passive)?.[1]?.split(",") ?? [];
            const port = Number(numbers[4]) * 256 + Number(numbers[5]);

            expect(passive).toStartWith("227");
            expect(numbers.slice(0, 4).join(".")).toBe("127.0.0.1");

            const data = connect({ port, host: "127.0.0.1" });

            await new Promise<void>((done) =>
              data.once("connect", () => done()),
            );

            expect(
              await ftp.send("STOR Front Door_00_20260713123456.mp4"),
            ).toStartWith("150");

            await write(data, "clip bytes");

            expect(await ftp.read()).toStartWith("226");
            expect(await ftp.send("RETR anything")).toStartWith("550");
            expect(await ftp.send("QUIT")).toStartWith("221");

            ftp.socket.destroy();
          });
        }),
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.upload.user).toBe("camera");
    expect(received[0]?.upload.path).toBe(
      "/clips/Front Door_00_20260713123456.mp4",
    );
    expect(received[0]?.text).toBe("clip bytes");
  });

  test("keeps paths inside the root", () => {
    expect(resolve("/a/b", "../../../c")).toBe("/c");
    expect(resolve("/a", "/b/./c")).toBe("/b/c");
    expect(parse("stor Front Door.mp4")).toEqual({
      verb: "STOR",
      argument: "Front Door.mp4",
    });
  });
});
