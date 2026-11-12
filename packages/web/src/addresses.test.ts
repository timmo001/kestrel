/** Checks that addresses and settings from before camera ids still land on the recorder's cameras. */
import { expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { newAddress, SavedCamera } from "./addresses.ts";

const pages = new Set(["live", "recordings", "events", "sources"]);

const moved = (address: string) =>
  newAddress(new URL(address, "https://kestrel.localhost"), pages);

test("a Recordings link by channel number goes to the recorder's cameras", () => {
  expect(
    moved(
      "/recordings?channel=3&channels=1,3&date=2026-11-11&at=2026-11-11T12:00:00",
    ),
  ).toBe(
    "/recordings?date=2026-11-11&at=2026-11-11T12%3A00%3A00&camera=swann%2F3&cameras=swann%2F1%2Cswann%2F3",
  );
});

test("current addresses stay as they are", () => {
  expect(moved("/recordings?camera=swann/3&date=2026-11-11")).toBeUndefined();
  expect(moved("/")).toBeUndefined();
});

test("old hash addresses go to their page", () => {
  expect(moved("/#events")).toBe("/events");
});

test("the Recorder page's addresses go to Sources", () => {
  expect(moved("/recorder")).toBe("/sources");
  expect(moved("/#recorder")).toBe("/sources");
});

test("a saved channel number reads as the recorder's camera, and an id as itself", () => {
  const decode = Schema.decodeUnknownOption(SavedCamera);

  expect(decode(3)).toEqual(Option.some("swann/3"));
  expect(decode("3")).toEqual(Option.some("swann/3"));
  expect(decode("swann/3")).toEqual(Option.some("swann/3"));
  expect(Option.isNone(decode(0))).toBe(true);
});
