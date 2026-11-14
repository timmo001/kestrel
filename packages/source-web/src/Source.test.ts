/** Tests for the commands the web source hands go2rtc, and the pages it takes. */
import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { echoAddress, make } from "./Source.ts";

const settingsWith = (page: string) => ({
  id: "web",
  kind: "web",
  name: "Web",
  enabled: true,
  settings: {},
  cameras: [{ id: "harbour", name: "Harbour", page }],
  secrets: [],
});

test("takes only http and https pages", async () => {
  for (const page of [
    "exec:ffmpeg -i x -f rtsp {output}",
    "echo:yt-dlp -g https://example.com",
    "file:///etc/passwd",
    "rtsp://192.0.2.20/stream",
  ]) {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(make(settingsWith(page))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  }
});

test("puts the page after -- with no spaces or fragment", () => {
  const address = echoAddress(
    "C:\\Program Files\\Kestrel\\yt-dlp.exe",
    "C:\\Program Files\\Kestrel\\node.exe",
    "https://www.example.com/watch?v=a b&x='--exec'#t=1",
    "b/bv",
  );

  expect(address).toBe(
    `echo:"C:\\Program Files\\Kestrel\\yt-dlp.exe" --ignore-config --quiet --no-warnings --js-runtimes "node:C:\\Program Files\\Kestrel\\node.exe" --format b/bv --print ffmpeg:%(url)s#video=copy#audio=aac -- https://www.example.com/watch?v=a%20b&x=%27--exec%27`,
  );
});
