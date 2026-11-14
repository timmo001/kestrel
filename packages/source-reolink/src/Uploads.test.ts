/** Reading when a clip a Reolink camera sent starts, from its name. */
import { describe, expect, test } from "bun:test";
import { clipStart } from "./Uploads.ts";

describe("clipStart", () => {
  test("reads the time from a clip's name", () => {
    expect(clipStart("/kestrel/Front Door_00_20260713123456.mp4")).toBe(
      "2026-07-13T12:34:56",
    );
    expect(clipStart("Front Door_00_20260713_123456.MP4")).toBe(
      "2026-07-13T12:34:56",
    );
  });

  test("leaves out pictures and impossible times", () => {
    expect(clipStart("Front Door_00_20260713123456.jpg")).toBeNull();
    expect(clipStart("Front Door_00_20261313123456.mp4")).toBeNull();
    expect(clipStart("test.mp4")).toBeNull();
  });
});
