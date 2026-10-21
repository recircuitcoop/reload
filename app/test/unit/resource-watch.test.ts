// The resource watchdog of one process (application/resource-watch.ts), on a fake clock and a
// fake probe: what it samples, when it stops, what a failed sample costs, and the person's
// defaults (tests/test_helper_detection.py, tests/test_helper_tick.py).

import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import {
  DEFAULT_WATCH_PACE,
  readPersonalLimits,
  resourceWatchdog,
} from "../../src/application/resource-watch";
import { DEFAULT_LIMITS, type ResourceSample } from "../../src/domain/supervision/resources";
import type { ProcessReading, ResourceProbe, WatchedProcess } from "../../src/ports/resource-watch";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger, RecordingNotifier } from "../fixtures/raw-node/fixture";

const QUIET: ResourceSample = { memoryMb: 100, cpuSeconds: 0, openFiles: 10, children: 0 };
const HUNGRY: ResourceSample = { ...QUIET, memoryMb: 2048 };
const EVERY = DEFAULT_WATCH_PACE.sampleEveryMs;
const STOP = DEFAULT_WATCH_PACE.stopTimeoutMs;

/** Lets the probe's promise settle, as the event loop would between two samples. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function harness(reading: (pid: number) => ResourceSample | null) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  /** The pids of each read of the process table, in order. */
  const passes: number[][] = [];
  const events: string[] = [];
  const identities = new Map<number, string>();
  let failing = false;
  const probe: ResourceProbe = (pids) => {
    passes.push([...pids]);
    if (failing) {
      failing = false;
      return Promise.reject(new Error("ps: the process table could not be read"));
    }
    const readings = new Map<number, ProcessReading>();
    for (const pid of pids) {
      const sample = reading(pid);
      if (sample !== null) {
        readings.set(pid, { sample, identity: identities.get(pid) ?? `started-${String(pid)}` });
      }
    }
    return Promise.resolve(readings);
  };
  const watchdog = resourceWatchdog({
    probe,
    clock,
    pace: DEFAULT_WATCH_PACE,
    log: (level, message) => {
      logger[level](message);
    },
  });
  const alive = new Set<number>();
  const target = (pid: number, limits = DEFAULT_LIMITS): WatchedProcess => {
    alive.add(pid);
    return {
      pid,
      limits,
      stop: () => events.push(`SIGTERM ${String(pid)}`),
      kill: () => events.push(`SIGKILL ${String(pid)}`),
      current: () => alive.has(pid),
      stopped: (why) => events.push(`stopped ${String(pid)}: ${why}`),
    };
  };
  const signals = (): string[] => events.filter((event) => event.startsWith("SIG"));
  return {
    clock,
    logger,
    passes,
    events,
    signals,
    watchdog,
    target,
    identities,
    failNextPass: () => {
      failing = true;
    },
    exit: (pid: number) => alive.delete(pid),
    tick: async (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        clock.advance(EVERY);
        await settle();
      }
    },
  };
}

describe("the resource watchdog", () => {
  it("samples every process it watches in one read of the process table per tick", async () => {
    const h = harness(() => QUIET);
    h.watchdog(h.target(10));
    h.watchdog(h.target(20));
    h.watchdog(h.target(30));
    await h.tick(3);
    expect(h.passes).toEqual([
      [10, 20, 30],
      [10, 20, 30],
      [10, 20, 30],
    ]);
    expect(h.events).toEqual([]);
  });

  it("stops a sustained breach politely, then forced after the stop timeout, checking it is still itself before each", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(7); // over from 10 s; at 70 s only exactly the grace window
    expect(h.events).toEqual([]);
    await h.tick(1);
    expect(h.events).toEqual([
      "stopped 10: memory 2048 MB, over its limit of 1024 MB, for 70 s",
      "SIGTERM 10",
    ]);
    h.clock.advance(STOP);
    await settle();
    expect(h.events.at(-1)).toBe("SIGKILL 10");
    // A read before the SIGTERM, and one before the SIGKILL.
    expect(h.passes.slice(-2)).toEqual([[10], [10]]);
    // Acting ends the watch: the process that comes back is watched afresh.
    await h.tick(3);
    expect(h.passes).toHaveLength(10);
  });

  it("sends nothing to a pid that is another process now, the moment before a signal", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(7);
    // Between the sample that finds it sustained and the read before the SIGTERM, the pid is
    // reused: same number, another start time.
    h.clock.advance(EVERY);
    h.identities.set(10, "started-later");
    await settle();
    expect(h.signals()).toEqual([]);
    expect(h.logger.has(/process 10 is gone or is another process now; nothing is sent/)).toBe(
      true,
    );
  });

  it("sends no kill to a pid reused while it waited out the stop timeout", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(8);
    h.identities.set(10, "started-later");
    h.clock.advance(STOP);
    await settle();
    expect(h.signals()).toEqual(["SIGTERM 10"]);
  });

  it("stops watching a pid that turns out to be another process at a sample", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(3);
    h.identities.set(10, "started-later");
    await h.tick(10);
    expect(h.signals()).toEqual([]);
    expect(h.passes).toHaveLength(4);
  });

  it("does not force a process that stopped when asked", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(8);
    h.exit(10);
    h.clock.advance(STOP);
    await settle();
    expect(h.signals()).toEqual(["SIGTERM 10"]);
  });

  it("gives a process that replaced a stopped one its whole grace window again", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(8);
    h.exit(10);
    h.watchdog(h.target(11));
    await h.tick(7);
    expect(h.signals().filter((event) => event === "SIGTERM 11")).toEqual([]);
    await h.tick(1);
    expect(h.signals().at(-1)).toBe("SIGTERM 11");
  });

  it("is watched against the limits it was given", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10, { ...DEFAULT_LIMITS, memoryMb: 4096 }));
    await h.tick(10);
    expect(h.events).toEqual([]);
  });

  it("counts a pass that throws as one failed pass, and still takes the next", async () => {
    const h = harness(() => QUIET);
    h.watchdog(h.target(10));
    await h.tick(1);
    h.failNextPass();
    await h.tick(3);
    expect(h.passes).toHaveLength(4);
    expect(
      h.logger.lines.filter((line) =>
        /one pass of the resource watchdog failed: Error: ps:/.test(line.text),
      ),
    ).toHaveLength(1);
  });

  it("logs a check before a signal that throws, and sends nothing", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(7);
    h.failNextPass();
    h.clock.advance(EVERY);
    // The sample passes; the read just before the SIGTERM fails.
    await settle();
    expect(h.signals()).toEqual([]);
  });

  it("judges the others in the same pass when one process vanished from it", async () => {
    // 20 went between the check and the read: the table no longer has it.
    const h = harness((pid) => (pid === 20 ? null : HUNGRY));
    h.watchdog(h.target(10));
    h.watchdog(h.target(20));
    h.watchdog(h.target(30));
    await h.tick(8);
    expect(h.passes[7]).toEqual([10, 20, 30]);
    expect(h.signals()).toEqual(["SIGTERM 10", "SIGTERM 30"]);
  });

  it("judges nothing from no reading, and keeps watching", async () => {
    const h = harness(() => null);
    h.watchdog(h.target(10));
    await h.tick(10);
    expect(h.passes).toHaveLength(10);
    expect(h.events).toEqual([]);
  });

  it("stops watching once the process is gone, even with a sample in flight", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(7);
    h.clock.advance(EVERY); // the sample that would find it sustained is taken...
    h.exit(10); // ...and the process exits before its answer is judged
    await settle();
    await h.tick(3);
    expect(h.passes).toHaveLength(8);
    expect(h.events).toEqual([]);
  });

  it("leaves nothing scheduled once every watch is cancelled, a kill in waiting included", async () => {
    const h = harness(() => HUNGRY);
    const cancel = h.watchdog(h.target(10));
    await h.tick(8);
    cancel();
    expect(h.clock.pending).toBe(0);
    h.clock.advance(STOP);
    await settle();
    expect(h.signals()).toEqual(["SIGTERM 10"]);
    const quiet = harness(() => QUIET);
    quiet.watchdog(quiet.target(10))();
    expect(quiet.clock.pending).toBe(0);
  });
});

describe("the person's own limits", () => {
  it("are read from the settings file's limits", () => {
    const logger = new RecordingLogger();
    const limits = readPersonalLimits({ readLimitDefaults: () => ({ children: 4 }) }, logger);
    expect(limits).toEqual({ ...DEFAULT_LIMITS, children: 4 });
    expect(readPersonalLimits({ readLimitDefaults: () => undefined }, logger)).toEqual(
      DEFAULT_LIMITS,
    );
  });

  it("fall back to the documented ones, said in the log, when the setting is broken", () => {
    const logger = new RecordingLogger();
    const broken = {
      readLimitDefaults: () => {
        throw new Error("the limits setting in shell-settings.json: grace_s must be a number");
      },
    };
    const notifier = new RecordingNotifier();
    expect(readPersonalLimits(broken, logger, notifier)).toEqual(DEFAULT_LIMITS);
    // Told to the person too, naming the file, as the old HelperConfigError was.
    expect(notifier.notices).toEqual([
      {
        kind: "limits-unreadable",
        subject: "limits",
        detail: "the limits setting in shell-settings.json: grace_s must be a number",
      },
    ]);
    readPersonalLimits({ readLimitDefaults: () => undefined }, logger, notifier);
    expect(notifier.cleared).toEqual(["limits-unreadable limits"]);
    expect(logger.has(/grace_s must be a number.*the documented resource limits are used/)).toBe(
      true,
    );
  });
});

describe("the settings file's limits", () => {
  function store(document: unknown): JsonSettingsStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reload-limits-"));
    const file = path.join(dir, "shell-settings.json");
    fs.writeFileSync(file, JSON.stringify(document));
    return new JsonSettingsStore(file);
  }

  it("are the person's defaults, raised as the old [helper.defaults] allowed", () => {
    expect(store({}).readLimitDefaults()).toBeUndefined();
    expect(store({ limits: { memory_mb: 4096, grace_s: 5 } }).readLimitDefaults()).toEqual({
      memory_mb: 4096,
      grace_s: 5,
    });
  });

  it("are refused, naming the file and the problem, when they are not limits", () => {
    expect(() => store({ limits: { max_rss_mb: 4096 } }).readLimitDefaults()).toThrow(
      /the limits setting in .*shell-settings\.json: max_rss_mb is not a limit/,
    );
  });
});
