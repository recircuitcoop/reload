// The resource watchdog's judgement (domain/supervision/resources.ts), kept from the old
// helper's detection.py and its tests (tests/test_helper_detection.py), with the one change the
// owner asked for (plan 0031): CPU warns and never stops.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMITS,
  describeBreach,
  limitsFor,
  ResourceWatch,
  type ResourceLimits,
  type ResourceSample,
} from "../../src/domain/supervision/resources";

const QUIET: ResourceSample = { memoryMb: 100, cpuSeconds: 0, openFiles: 10, children: 0 };
const GRACE = DEFAULT_LIMITS.graceMs;

function sample(overrides: Partial<ResourceSample>): ResourceSample {
  return { ...QUIET, ...overrides };
}

describe("the limits in force", () => {
  it("are the old helper's defaults for a package that declares none", () => {
    expect(limitsFor(undefined)).toEqual({
      memoryMb: 1024,
      cpuPercent: 90,
      cpuWindowMs: 120_000,
      openFiles: 1024,
      children: 32,
      graceMs: 60_000,
    });
    expect(limitsFor({})).toEqual(DEFAULT_LIMITS);
  });

  it("are what a package declared, so one that asked for 2 GB is watched against 2 GB", () => {
    const limits = limitsFor({ memory_mb: 2048 });
    expect(limits.memoryMb).toBe(2048);
    const watch = new ResourceWatch(limits);
    watch.observe(sample({ memoryMb: 1500 }), 0);
    expect(watch.observe(sample({ memoryMb: 1500 }), GRACE + 1).breaches).toEqual([]);
  });

  it("fill every key a package left out from the defaults, the child limit included", () => {
    expect(limitsFor({ children: 64, grace_s: 120, cpu_window_s: 300 })).toEqual({
      ...DEFAULT_LIMITS,
      children: 64,
      graceMs: 120_000,
      cpuWindowMs: 300_000,
    });
    expect(limitsFor({ open_files: 4096, cpu_percent: 150 })).toMatchObject({
      openFiles: 4096,
      cpuPercent: 150,
      children: DEFAULT_LIMITS.children,
    });
  });
});

describe("a breach", () => {
  it("inside the grace window is reported and not acted on", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ memoryMb: 2000 }), 0);
    const verdict = watch.observe(sample({ memoryMb: 2000 }), GRACE);
    expect(verdict.breaches).toEqual([
      { limit: "memory", value: 2000, allowed: 1024, durationMs: GRACE, sustained: false },
    ]);
    expect(verdict.stop).toEqual([]);
  });

  it("sustained one instant past the grace window is acted on", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ memoryMb: 2000 }), 0);
    const verdict = watch.observe(sample({ memoryMb: 2000 }), GRACE + 1);
    expect(verdict.stop.map((breach) => breach.limit)).toEqual(["memory"]);
  });

  it("that comes back under the limit starts its next grace window from zero", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ memoryMb: 2000 }), 0);
    watch.observe(sample({ memoryMb: 500 }), GRACE / 2);
    watch.observe(sample({ memoryMb: 2000 }), GRACE);
    const verdict = watch.observe(sample({ memoryMb: 2000 }), GRACE + 1);
    expect(verdict.breaches[0]?.durationMs).toBe(1);
    expect(verdict.stop).toEqual([]);
  });

  it("is judged against the package's own grace window", () => {
    const watch = new ResourceWatch(limitsFor({ grace_s: 300 }));
    watch.observe(sample({ memoryMb: 2000 }), 0);
    expect(watch.observe(sample({ memoryMb: 2000 }), 299_000).stop).toEqual([]);
    expect(watch.observe(sample({ memoryMb: 2000 }), 300_001).stop).toHaveLength(1);
  });

  it("of open files over the limit stops the process", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ openFiles: 5000 }), 0);
    expect(watch.observe(sample({ openFiles: 5000 }), GRACE + 1).stop).toMatchObject([
      { limit: "open-files", value: 5000, allowed: 1024 },
    ]);
  });

  it("of children over the default limit stops the process", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ children: 33 }), 0);
    expect(watch.observe(sample({ children: 33 }), GRACE + 1).stop).toMatchObject([
      { limit: "children", value: 33, allowed: 32 },
    ]);
  });

  it("is not judged from a reading the platform did not give, and keeps its clock", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ openFiles: 5000 }), 0);
    const unread = watch.observe(sample({ openFiles: null }), GRACE / 2);
    expect(unread.breaches).toEqual([]);
    expect(watch.observe(sample({ openFiles: 5000 }), GRACE + 1).stop).toHaveLength(1);
  });
});

describe("CPU", () => {
  const limits: ResourceLimits = { ...DEFAULT_LIMITS, cpuWindowMs: 100_000, graceMs: 0 };

  it("is unknown from one sample, and measured over the window from two totals", () => {
    const watch = new ResourceWatch(limits);
    expect(watch.observe(sample({ cpuSeconds: 10 }), 0).cpuPercent).toBeNull();
    // 50 CPU seconds in 100 s: half a core.
    expect(watch.observe(sample({ cpuSeconds: 60 }), 100_000).cpuPercent).toBe(50);
    expect(watch.observe(sample({ cpuSeconds: null }), 110_000).cpuPercent).toBeNull();
  });

  it("inside the window cannot be hidden by a later idle sample", () => {
    const watch = new ResourceWatch(limits);
    watch.observe(sample({ cpuSeconds: 0 }), 0);
    // A burst of 95 s of CPU in the first 100 s, then idle for 10 s.
    watch.observe(sample({ cpuSeconds: 95 }), 100_000);
    const verdict = watch.observe(sample({ cpuSeconds: 95 }), 110_000);
    // The sample from before the window's edge is kept: 95 s over 110 s, still over 80 %.
    expect(verdict.cpuPercent).toBeCloseTo(86.36, 1);
  });

  it("held past the grace window warns and never stops the process: long jobs are legal", () => {
    const watch = new ResourceWatch({ ...limits, cpuPercent: 90, graceMs: 60_000 });
    watch.observe(sample({ cpuSeconds: 0 }), 0);
    watch.observe(sample({ cpuSeconds: 15 }), 10_000);
    const verdict = watch.observe(sample({ cpuSeconds: 105 }), 70_001);
    expect(verdict.busy).toMatchObject({ limit: "cpu", sustained: true });
    expect(verdict.stop).toEqual([]);
  });
});

describe("the words for a breach", () => {
  it("carry the numbers that triggered it", () => {
    const memory = { limit: "memory", value: 1300.4, allowed: 1024, durationMs: 61_000 } as const;
    expect(describeBreach({ ...memory, sustained: true })).toBe(
      "memory 1300 MB, over its limit of 1024 MB, for 61 s",
    );
    expect(
      describeBreach({ limit: "cpu", value: 150, allowed: 90, durationMs: 0, sustained: false }),
    ).toBe("CPU 150 %, over its limit of 90 %, for 0 s");
    expect(
      describeBreach({
        limit: "open-files",
        value: 2000,
        allowed: 1024,
        durationMs: 1000,
        sustained: true,
      }),
    ).toBe("open files 2000, over its limit of 1024, for 1 s");
  });
});
