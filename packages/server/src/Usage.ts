/**
 * Watches how much of the machine Kestrel uses, and holds background work
 * back while it's past its limits. Every 10 seconds it reads the machine's
 * free memory, swap and load, and the memory and CPU of the server and the
 * processes it started, such as go2rtc and ffmpeg; on Linux from `/proc`,
 * elsewhere the server's own only. It keeps the last hour, and counts what
 * recordings use every 10 minutes. Background work, such as copying from
 * sources, waits in `whenRoom` while Kestrel or the machine is past a
 * limit; live view and recording never do.
 *
 * @module
 */
import { defaultLimits, type Limits } from "@timmo001/kestrel-core";
import * as Nvr from "@timmo001/kestrel-nvr";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import {
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Stream,
} from "effect";
import type {
  DiskUsage,
  ProcessUsage,
  StoredCamera,
  UsageReport,
  UsageSample,
} from "./Api.ts";
import { ownRecordingsFolder } from "./Folders.ts";
import { Sources } from "./Sources.ts";

/** How often usage is read. */
const every = Duration.seconds(10);

/** How many readings are kept: an hour's. */
const kept = 360;

/** How often what recordings use is counted, which reads every file. */
const countEvery = Duration.minutes(10);

/** Linux's clock ticks a second, which `/proc` gives CPU time in. */
const ticksPerSecond = 100;

const megabyte = 1024 * 1024;

/**
 * How much of the last 10 seconds something waited for memory or the disk,
 * as a percentage, past which background work waits. Memory this short
 * means the machine is swapping; the disk this busy, that recordings or
 * other apps need it.
 */
const pressureLimits = { memory: 5, disk: 30 };

const megabytes = (bytes: number) => `${Math.round(bytes / megabyte)} MB`;

/**
 * Why background work should wait, from the newest readings, or nothing.
 * Memory goes by the newest; CPU by the last three, about half a minute, so
 * a moment's work doesn't stop it.
 */
export const holdUpFor = (
  limits: Limits,
  recent: ReadonlyArray<UsageSample>,
): string | undefined => {
  const newest = recent.at(-1);

  if (newest === undefined) return undefined;

  if (newest.memoryFree < (newest.memory * limits.memoryFree) / 100) {
    return `the machine has ${megabytes(newest.memoryFree)} of memory free, under the ${limits.memoryFree}% kept free`;
  }

  if (newest.memoryPressure > pressureLimits.memory) {
    return `the machine is short of memory, waiting on it ${Math.round(newest.memoryPressure)}% of the time`;
  }

  if (newest.diskPressure > pressureLimits.disk) {
    return `the machine's disks are busy, waited on ${Math.round(newest.diskPressure)}% of the time`;
  }

  if (newest.kestrelMemory > limits.memoryLimit * megabyte) {
    return `Kestrel uses ${megabytes(newest.kestrelMemory)} of memory, over its ${limits.memoryLimit} MB`;
  }

  const lately = recent.slice(-3);

  const cpu =
    lately.reduce((total, sample) => total + sample.kestrelCpu, 0) /
    lately.length /
    Math.max(newest.cores, 1);

  if (cpu > limits.cpuShare) {
    return `Kestrel uses ${Math.round(cpu)}% of the CPU, over its ${limits.cpuShare}%`;
  }

  return undefined;
};

/** A process as `/proc/<pid>/stat` gives it. */
interface ProcessStat {
  readonly pid: number;
  readonly parent: number;
  readonly name: string;
  /** CPU time used, in clock ticks. */
  readonly ticks: number;
}

/** Reads `/proc/<pid>/stat`, whose name may hold spaces and brackets. */
const parseStat = (pid: number, text: string): ProcessStat | undefined => {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");

  if (open === -1 || close === -1) return undefined;

  // From the state on: state, parent, ..., user time (12th) and system time (13th)
  const fields = text.slice(close + 2).split(" ");

  return {
    pid,
    parent: Number(fields[1]),
    name: text.slice(open + 1, close),
    ticks: Number(fields[11]) + Number(fields[12]),
  };
};

/** The value of a `/proc` key in kB, such as `MemAvailable` or `VmRSS`, in bytes. */
const kilobytes = (text: string, key: string) => {
  const match = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);

  return match === null ? undefined : Number(match[1]) * 1024;
};

/** The `some avg10` share from a `/proc/pressure` file, or 0. */
const pressure = (text: Option.Option<string>) =>
  Option.match(text, {
    onNone: () => 0,
    onSome: (found) => Number(/^some avg10=([\d.]+)/m.exec(found)?.[1] ?? 0),
  });

export class Usage extends Context.Service<
  Usage,
  {
    readonly report: Effect.Effect<UsageReport>;
    /**
     * Waits while background work should, telling `onWait` why each time
     * the reason changes, and says whether it waited.
     */
    readonly whenRoom: (
      onWait: (reason: string) => Effect.Effect<void>,
    ) => Effect.Effect<boolean>;
  }
>()("@timmo001/kestrel-server/Usage") {
  static readonly layer = Layer.effect(
    Usage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sources = yield* Sources;
      const own = yield* ownRecordingsFolder;

      const recording = yield* Ref.make((yield* sources.settings).recording);

      yield* sources.recording.pipe(
        Stream.runForEach((settings) => Ref.set(recording, settings)),
        Effect.forkScoped,
      );

      const read = (file: string) =>
        fs.readFileString(file).pipe(Effect.option);

      /** The container's memory limit and use, when it has one. */
      const container = Effect.gen(function* () {
        const max = yield* read("/sys/fs/cgroup/memory.max");
        const current = yield* read("/sys/fs/cgroup/memory.current");

        if (Option.isNone(max) || Option.isNone(current)) {
          return Option.none();
        }

        const limit = Number(max.value.trim());
        const used = Number(current.value.trim());

        return Number.isFinite(limit) && Number.isFinite(used)
          ? Option.some({ limit, used })
          : Option.none();
      });

      /** The server and every process it started, and theirs. */
      const ours = Effect.gen(function* () {
        const pids = (yield* fs
          .readDirectory("/proc")
          .pipe(Effect.orElseSucceed((): Array<string> => [])))
          .filter((name) => /^\d+$/.test(name))
          .map(Number);

        const stats = yield* Effect.forEach(pids, (pid) =>
          read(`/proc/${pid}/stat`).pipe(
            Effect.map(
              Option.flatMap((text) =>
                Option.fromUndefinedOr(parseStat(pid, text)),
              ),
            ),
          ),
        );

        const all = stats.flatMap((stat) => Option.toArray(stat));
        const family = new Set([process.pid]);

        // Parents come before their children often enough, but not always
        for (let grew = true; grew;) {
          grew = false;

          for (const stat of all) {
            if (family.has(stat.parent) && !family.has(stat.pid)) {
              family.add(stat.pid);
              grew = true;
            }
          }
        }

        return yield* Effect.forEach(
          all.filter((stat) => family.has(stat.pid)),
          (stat) =>
            read(`/proc/${stat.pid}/status`).pipe(
              Effect.map((status) => ({
                ...stat,
                memory: Option.match(status, {
                  onNone: () => 0,
                  onSome: (text) => kilobytes(text, "VmRSS") ?? 0,
                }),
              })),
            ),
        );
      });

      const samples = yield* Ref.make<Array<UsageSample>>([]);
      const processes = yield* Ref.make<Array<ProcessUsage>>([]);
      const ticks = yield* Ref.make({ at: 0, by: new Map<number, number>() });
      const counted = yield* Ref.make<Option.Option<DiskUsage>>(Option.none());
      const holdUp = yield* Ref.make<string | undefined>(undefined);

      const sample = Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const meminfo = yield* read("/proc/meminfo");
        const machine = yield* container;
        const found = yield* ours;
        const before = yield* Ref.get(ticks);
        const seconds = (at - before.at) / 1000;

        const each: Array<ProcessUsage> =
          found.length > 0
            ? found.map((proc) => {
                const was = before.by.get(proc.pid);

                return {
                  name: proc.pid === process.pid ? "kestrel" : proc.name,
                  memory: proc.memory,
                  cpu:
                    was === undefined || seconds <= 0
                      ? 0
                      : ((proc.ticks - was) / ticksPerSecond / seconds) * 100,
                };
              })
            : [
                {
                  name: "kestrel",
                  memory: process.memoryUsage.rss(),
                  cpu:
                    seconds <= 0
                      ? 0
                      : (((process.cpuUsage().user +
                          process.cpuUsage().system) /
                          1e6 -
                          (before.by.get(process.pid) ?? 0) / ticksPerSecond) /
                          seconds) *
                        100,
                },
              ];

        yield* Ref.set(ticks, {
          at,
          by: new Map(
            found.length > 0
              ? found.map((proc) => [proc.pid, proc.ticks])
              : [
                  [
                    process.pid,
                    ((process.cpuUsage().user + process.cpuUsage().system) /
                      1e6) *
                      ticksPerSecond,
                  ],
                ],
          ),
        });

        const memory = Option.match(meminfo, {
          onNone: () => ({ total: totalmem(), free: freemem(), swap: 0 }),
          onSome: (text) => ({
            total: kilobytes(text, "MemTotal") ?? totalmem(),
            free: kilobytes(text, "MemAvailable") ?? freemem(),
            swap:
              (kilobytes(text, "SwapTotal") ?? 0) -
              (kilobytes(text, "SwapFree") ?? 0),
          }),
        });

        // A container with a limit lower than the machine's runs out first
        const limited = Option.filter(
          machine,
          ({ limit }) => limit < memory.total,
        );

        const next: UsageSample = {
          at,
          memory: Option.match(limited, {
            onNone: () => memory.total,
            onSome: ({ limit }) => limit,
          }),
          memoryFree: Option.match(limited, {
            onNone: () => memory.free,
            onSome: ({ limit, used }) =>
              Math.min(memory.free, Math.max(0, limit - used)),
          }),
          swapUsed: memory.swap,
          memoryPressure: pressure(yield* read("/proc/pressure/memory")),
          diskPressure: pressure(yield* read("/proc/pressure/io")),
          cores: availableParallelism(),
          load: loadavg()[0] ?? 0,
          kestrelMemory: each.reduce((total, proc) => total + proc.memory, 0),
          kestrelCpu: each.reduce((total, proc) => total + proc.cpu, 0),
        };

        // The first reading has no CPU time to compare with
        if (before.at === 0) return;

        yield* Ref.set(processes, each);

        const recent = yield* Ref.updateAndGet(samples, (all) =>
          [...all, next].slice(-kept),
        );

        const reason = holdUpFor((yield* Ref.get(recording)).limits, recent);
        const was = yield* Ref.getAndSet(holdUp, reason);

        if (reason !== undefined && was === undefined) {
          yield* Effect.logWarning(`Background work waits: ${reason}`);
        } else if (reason === undefined && was !== undefined) {
          yield* Effect.logInfo("Background work carries on");
        }
      });

      const count = Effect.gen(function* () {
        const settings = yield* Ref.get(recording);
        const folder = settings.folder ?? own;
        const space = yield* Nvr.disk(folder);
        const files = yield* Nvr.stored(folder);
        const cameras = new Map<string, StoredCamera>();

        for (const file of files) {
          const camera = path
            .relative(folder, path.dirname(path.dirname(file.path)))
            .split(path.sep)
            .join("/");

          const was = cameras.get(camera) ?? { camera, files: 0, bytes: 0 };

          cameras.set(camera, {
            camera,
            files: was.files + 1,
            bytes: was.bytes + file.bytes,
          });
        }

        const used = files.reduce((total, file) => total + file.bytes, 0);

        yield* Ref.set(
          counted,
          Option.some({
            folder,
            total: space.total,
            free: space.free,
            recordings: used,
            allowed: Nvr.budget(settings, space, used),
            diskShare: settings.diskShare,
            cameras: [...cameras.values()].toSorted((a, b) =>
              a.camera.localeCompare(b.camera),
            ),
            counted: new Date(yield* Clock.currentTimeMillis).toISOString(),
          }),
        );
      });

      yield* sample.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Usage couldn't be read", cause),
        ),
        Effect.repeat(Schedule.spaced(every)),
        Effect.forkScoped,
      );

      // Not until a folder exists, which the first recording or copy makes
      yield* count.pipe(
        Effect.catch(() => Effect.void),
        Effect.repeat(Schedule.spaced(countEvery)),
        Effect.forkScoped,
      );

      /** The disk's free space now, and the last count of what's in it. */
      const disk = Effect.gen(function* () {
        const last = yield* Ref.get(counted);

        if (Option.isNone(last)) return undefined;

        const space = yield* Nvr.disk(last.value.folder).pipe(Effect.option);

        return Option.match(space, {
          onNone: () => last.value,
          onSome: (now) => ({
            ...last.value,
            total: now.total,
            free: now.free,
          }),
        });
      });

      const whenRoom = (onWait: (reason: string) => Effect.Effect<void>) =>
        Effect.gen(function* () {
          let told: string | undefined;

          for (;;) {
            const reason = yield* Ref.get(holdUp);

            if (reason === undefined) return told !== undefined;

            if (reason !== told) {
              yield* onWait(reason);
              told = reason;
            }

            yield* Effect.sleep(every);
          }
        });

      return Usage.of({
        report: Effect.gen(function* () {
          const history = yield* Ref.get(samples);
          const reason = yield* Ref.get(holdUp);
          const found = yield* disk;

          return {
            limits: (yield* Ref.get(recording)).limits ?? defaultLimits,
            holdUp: reason,
            now: history.at(-1) ?? {
              at: yield* Clock.currentTimeMillis,
              memory: totalmem(),
              memoryFree: freemem(),
              swapUsed: 0,
              memoryPressure: 0,
              diskPressure: 0,
              cores: availableParallelism(),
              load: loadavg()[0] ?? 0,
              kestrelMemory: process.memoryUsage.rss(),
              kestrelCpu: 0,
            },
            processes: yield* Ref.get(processes),
            disk: found,
            history,
          };
        }),
        whenRoom,
      });
    }),
  );
}
