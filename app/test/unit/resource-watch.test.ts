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
import type { ResourceProbe, WatchedProcess } from "../../src/ports/resource-watch";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger } from "../fixtures/raw-node/fixture";

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

function harness(reading: (pid: number) => ResourceSample | null | Error) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const sampled: number[] = [];
  const events: string[] = [];
  const probe: ResourceProbe = (pid) => {
    sampled.push(pid);
    const answer = reading(pid);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
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
  return {
    clock,
    logger,
    sampled,
    events,
    watchdog,
    target,
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
  it("samples every process it watches once per period, each by its own pid", async () => {
    const h = harness(() => QUIET);
    h.watchdog(h.target(10));
    h.watchdog(h.target(20));
    h.watchdog(h.target(30));
    await h.tick(3);
    expect(h.sampled).toEqual([10, 20, 30, 10, 20, 30, 10, 20, 30]);
    expect(h.events).toEqual([]);
  });

  it("stops a sustained breach politely, then forced after the stop timeout", async () => {
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
    expect(h.events.at(-1)).toBe("SIGKILL 10");
    // Acting ends the watch: the process that comes back is watched afresh.
    await h.tick(3);
    expect(h.sampled).toHaveLength(8);
  });

  it("does not force a process that stopped when asked", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(8);
    h.exit(10);
    h.clock.advance(STOP);
    expect(h.events.filter((event) => event.startsWith("SIG"))).toEqual(["SIGTERM 10"]);
  });

  it("gives a process that replaced a stopped one its whole grace window again", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10));
    await h.tick(8);
    h.exit(10);
    h.watchdog(h.target(11));
    await h.tick(7);
    expect(h.events.filter((event) => event === "SIGTERM 11")).toEqual([]);
    await h.tick(1);
    expect(h.events.at(-1)).toBe("SIGTERM 11");
  });

  it("is watched against the limits it was given", async () => {
    const h = harness(() => HUNGRY);
    h.watchdog(h.target(10, { ...DEFAULT_LIMITS, memoryMb: 4096 }));
    await h.tick(10);
    expect(h.events).toEqual([]);
  });

  it("counts a sample that throws as one failed sample, and still takes the next", async () => {
    let calls = 0;
    const h = harness(() => {
      calls += 1;
      return calls === 2 ? new Error("ps: the process table could not be read") : QUIET;
    });
    h.watchdog(h.target(10));
    await h.tick(4);
    expect(h.sampled).toHaveLength(4);
    expect(
      h.logger.lines.filter((line) =>
        /one sample of process 10 failed: Error: ps:/.test(line.text),
      ),
    ).toHaveLength(1);
  });

  it("judges nothing from no reading, and keeps watching", async () => {
    const h = harness(() => null);
    h.watchdog(h.target(10));
    await h.tick(10);
    expect(h.sampled).toHaveLength(10);
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
    expect(h.sampled).toHaveLength(8);
    expect(h.events).toEqual([]);
  });

  it("leaves nothing scheduled once cancelled", async () => {
    const h = harness(() => HUNGRY);
    const cancel = h.watchdog(h.target(10));
    await h.tick(8);
    cancel();
    expect(h.clock.pending).toBe(0);
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
    expect(readPersonalLimits(broken, logger)).toEqual(DEFAULT_LIMITS);
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
