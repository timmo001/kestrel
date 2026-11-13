/**
 * Runs the `kestrel` binary for the plugin and reads its Code Mode
 * manifest. Effect is pinned to the version `@opencode/plugin` uses, so the
 * plugin's effects run on OpenCode's own runtime.
 */
import { Tool } from "@opencode/schema/tool";
import { Duration, Effect, Schema } from "effect";

/** One tool, as `kestrel agent tools --json` prints it. */
export const ManifestTool = Schema.Struct({
  name: Schema.String,
  argv: Schema.Array(Schema.String),
  description: Schema.String,
  access: Schema.Literals(["read", "write"]),
  alwaysAsk: Schema.Boolean,
  pinned: Schema.Boolean,
  timeoutMillis: Schema.Int,
  json: Schema.Boolean,
  stdin: Schema.Boolean,
  input: Schema.Record(Schema.String, Schema.Unknown),
  resource: Schema.optionalKey(Schema.String),
});

export type ManifestTool = typeof ManifestTool.Type;

const Manifest = Schema.fromJsonString(
  Schema.Struct({ tools: Schema.Array(ManifestTool) }),
);

/**
 * What a failed command said, without the stack trace the CLI prints under
 * its error.
 */
const message = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .slice(0, 20)
    .join("\n");

interface RunOptions {
  readonly cwd?: string | undefined;
  readonly stdin?: string | undefined;
  readonly timeout: Duration.Input;
}

interface Spawn {
  cwd?: string;
  env: Record<string, string | undefined>;
  stdin: "ignore" | Response;
}

const spawnOptions = (options: RunOptions) => {
  const spawn: Spawn = {
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "ignore",
  };

  if (options.cwd !== undefined) spawn.cwd = options.cwd;

  if (options.stdin !== undefined) spawn.stdin = new Response(options.stdin);

  return spawn;
};

/** Run `kestrel` to completion, failing on a non-zero exit, and return stdout. */
export const runKestrel = (args: readonly string[], options: RunOptions) =>
  Effect.tryPromise({
    try: async (signal) => {
      // The platform packages for OpenCode's Effect pull in a newer
      // platform-node-shared that needs a newer Effect, so this spawns through
      // Bun, which OpenCode's server runs on.
      // oxlint-disable-next-line timmo-effect/prefer-platform-services
      const proc = Bun.spawn(["kestrel", ...args], {
        ...spawnOptions(options),
        stdout: "pipe",
        stderr: "pipe",
        signal,
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      return { stdout, stderr, exitCode };
    },
    catch: (error) =>
      new Tool.Error({
        message: `Could not run kestrel: ${String(error)}`,
        error,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () =>
        Effect.fail(
          new Tool.Error({
            message: `kestrel ${args.join(" ")} timed out after ${Duration.format(Duration.fromInputUnsafe(options.timeout))}`,
          }),
        ),
    }),
    Effect.flatMap((run) =>
      run.exitCode === 0
        ? Effect.succeed(run.stdout)
        : Effect.fail(
            new Tool.Error({
              message: `kestrel ${args.join(" ")} exited ${run.exitCode}\n${message(run.stderr || run.stdout)}`,
              metadata: { exitCode: run.exitCode },
            }),
          ),
    ),
  );

/** Read the tools from the installed binary, so they always match it. */
export const loadManifest = runKestrel(["agent", "tools", "--json"], {
  timeout: "30 seconds",
}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
