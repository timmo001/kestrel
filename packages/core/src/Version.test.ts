/** Checks a version mismatch tells you to update the side that's behind. */
import { expect, test } from "bun:test";
import { isOlder, mismatchMessage } from "./Version.ts";

test("versions compare number by number, not as text", () => {
  expect(isOlder("0.9.0", "0.10.0")).toBe(true);
  expect(isOlder("0.10.0", "0.9.0")).toBe(false);
  expect(isOlder("1.2.3", "1.2.3")).toBe(false);
});

test("the side that's behind is the one to update", () => {
  const where = "http://server:7380";

  expect(
    mismatchMessage({
      client: "0.2.0",
      server: "0.3.0",
      what: "This CLI",
      where,
    }),
  ).toContain("Update this CLI");

  expect(
    mismatchMessage({
      client: "0.3.0",
      server: "0.2.0",
      what: "This CLI",
      where,
    }),
  ).toContain("Update the server");
});
