/** Checks a copied source takes what it leaves out from the environment, named as the sources read it. */
import type { KindInfo } from "@timmo001/kestrel-core";
import { expect, test } from "bun:test";
import { environmentName, filledIn } from "./copy.ts";

test("a field's environment variable is named as the sources read it", () => {
  expect(environmentName("raysharp", "host")).toBe("KESTREL_RAYSHARP_HOST");
  expect(environmentName("raysharp", "rtspPort")).toBe(
    "KESTREL_RAYSHARP_RTSP_PORT",
  );
});

test("only fields left out or empty are filled in, numbers as numbers", () => {
  const kind: KindInfo = {
    kind: "raysharp",
    name: "Recorder",
    description: "",
    fields: (
      [
        ["host", "text"],
        ["port", "number"],
        ["username", "text"],
        ["password", "secret"],
      ] as const
    ).map(([key, type]) => ({
      key,
      label: key,
      type,
      required: false,
      hint: null,
    })),
    cameraFields: null,
  };

  const source = {
    id: "swann",
    kind: "raysharp",
    name: "Recorder",
    enabled: true,
    settings: { host: "", username: "kept" },
    cameras: [],
    secrets: [],
  };

  expect(
    filledIn(source, kind, {
      KESTREL_RAYSHARP_HOST: "recorder.example",
      KESTREL_RAYSHARP_PORT: "9000",
      KESTREL_RAYSHARP_USERNAME: "not used",
      KESTREL_RAYSHARP_PASSWORD: "from the environment",
    }).settings,
  ).toEqual({
    host: "recorder.example",
    port: 9000,
    username: "kept",
    password: "from the environment",
  });
});
