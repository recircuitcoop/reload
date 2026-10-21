// The resource watchdog's judgement (domain/supervision/resources.ts), kept from the old
// helper's detection.py, watch.py resolve_profile and their tests (tests/test_helper_detection.py,
// tests/test_helper_heartbeat.py).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMITS,
  describeBreach,
  limitsFor,
  limitsProblem,
  personalLimits,
  ResourceWatch,
  type Breach,
  type ResourceLimits,
  type ResourceSample,
} from "../../src/domain/supervision/resources";

const QUIET: ResourceSample = { memoryMb: 100, cpuSeconds: 0, openFiles: 10, children: 0 };
const GRACE = DEFAULT_LIMITS.graceMs;

/** The breaches acted on: those that outlasted their grace window. */
const acted = (breaches: readonly Breach[]): readonly Breach[] =>
  breaches.filter((breach) => breach.sustained);

function sample(overrides: Partial<ResourceSample>): ResourceSample {
  return { ...QUIET, ...overrides };
}

/** The person's own defaults with a child limit of 4, as the old tests' `max_children=4`. */
const PERSONAL = personalLimits({ children: 4 });

describe("the limits in force", () => {
  it("are the documented defaults for a person who set none", () => {
    expect(personalLimits(undefined)).toEqual({
      memoryMb: 1024,
      cpuPercent: 90,
      cpuWindowMs: 120_000,
      openFiles: 1024,
      children: 32,
      graceMs: 60_000,
    });
  });

  it("are the person's own defaults for a type that declared none", () => {
    const personal = personalLimits({ memory_mb: 4096, grace_s: 5, children: 4 });
    expect(limitsFor(undefined, personal)).toEqual({
      ...DEFAULT_LIMITS,
      memoryMb: 4096,
      graceMs: 5_000,
      children: 4,
    });
  });

  it("raised by the person keep a process under its old line from being judged", () => {
    const watch = new ResourceWatch(limitsFor(undefined, personalLimits({ memory_mb: 4096 })));
    watch.observe(sample({ memoryMb: 2048 }), 0);
    expect(acted(watch.observe(sample({ memoryMb: 2048 }), GRACE * 2))).toEqual([]);
  });

  it("are what a type declared, so one that asked for 2 GB is watched against 2 GB", () => {
    const limits = limitsFor({ memory_mb: 2048 }, PERSONAL);
    expect(limits.memoryMb).toBe(2048);
    const watch = new ResourceWatch(limits);
    watch.observe(sample({ memoryMb: 1500 }), 0);
    expect(acted(watch.observe(sample({ memoryMb: 1500 }), GRACE + 1))).toEqual([]);
  });

  it("fill a partial declaration from the documented defaults, and the child limit from the person's", () => {
    const personal = personalLimits({ memory_mb: 4096, children: 4 });
    expect(limitsFor({ grace_s: 120 }, personal)).toEqual({
      ...DEFAULT_LIMITS,
      graceMs: 120_000,
      children: 4,
    });
    expect(limitsFor({}, personal).children).toBe(4);
  });

  it("keep a child limit the type named itself", () => {
    expect(limitsFor({ children: 2 }, PERSONAL).children).toBe(2);
  });
});

describe("limits as written", () => {
  it("are any positive numbers, whole for the two counts, with no upper bound", () => {
    expect(limitsProblem({})).toBeNull();
    expect(
      limitsProblem({ memory_mb: 1.5, cpu_percent: 150, open_files: 1_000_000, children: 1 }),
    ).toBeNull();
  });

  it("are refused, in words, for an unknown key, a zero, a fraction of a count or a non-number", () => {
    expect(limitsProblem({ memory: 1 })).toBe(
      "memory is not a limit (the limits are memory_mb, cpu_percent, cpu_window_s, grace_s, " +
        "open_files, children)",
    );
    expect(limitsProblem({ grace_s: 0 })).toBe("grace_s must be a number greater than zero");
    expect(limitsProblem({ children: 1.5 })).toBe(
      "children must be a whole number greater than zero",
    );
    expect(limitsProblem({ memory_mb: "1" })).toBe("memory_mb must be a number greater than zero");
    expect(limitsProblem([])).toBe("must be an object of limits");
    expect(limitsProblem(null)).toBe("must be an object of limits");
  });
});

describe("a breach", () => {
  it("inside the grace window is reported, with how long it has lasted, and not acted on", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    expect(watch.observe(sample({ memoryMb: 2000 }), 0)).toEqual([
      { limit: "memory", value: 2000, allowed: 1024, durationMs: 0, sustained: false },
    ]);
    const inside = watch.observe(sample({ memoryMb: 2000 }), GRACE);
    expect(inside).toEqual([
      { limit: "memory", value: 2000, allowed: 1024, durationMs: GRACE, sustained: false },
    ]);
    expect(acted(inside)).toEqual([]);
  });

  it("sustained one instant past the grace window is acted on, with its numbers", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ memoryMb: 2000 }), 0);
    expect(acted(watch.observe(sample({ memoryMb: 2000 }), GRACE + 1))).toEqual([
      { limit: "memory", value: 2000, allowed: 1024, durationMs: GRACE + 1, sustained: true },
    ]);
  });

  it("that comes back under the limit starts its next grace window from zero", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ memoryMb: 2000 }), 0);
    watch.observe(sample({ memoryMb: 500 }), GRACE / 2);
    watch.observe(sample({ memoryMb: 2000 }), GRACE);
    expect(acted(watch.observe(sample({ memoryMb: 2000 }), GRACE * 2))).toEqual([]);
    expect(acted(watch.observe(sample({ memoryMb: 2000 }), GRACE * 2 + 1))).toHaveLength(1);
  });

  it("is judged against the type's own grace window", () => {
    const watch = new ResourceWatch(limitsFor({ grace_s: 300 }));
    watch.observe(sample({ memoryMb: 2000 }), 0);
    expect(acted(watch.observe(sample({ memoryMb: 2000 }), 299_000))).toEqual([]);
    expect(acted(watch.observe(sample({ memoryMb: 2000 }), 300_001))).toHaveLength(1);
  });

  it("of open files over the limit is acted on", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ openFiles: 5000 }), 0);
    expect(acted(watch.observe(sample({ openFiles: 5000 }), GRACE + 1))).toMatchObject([
      { limit: "open-files", value: 5000, allowed: 1024 },
    ]);
  });

  it("of children over the person's 32, for a type that declared limits but no child limit", () => {
    const watch = new ResourceWatch(limitsFor({ memory_mb: 2048 }, personalLimits(undefined)));
    watch.observe(sample({ children: 33 }), 0);
    expect(acted(watch.observe(sample({ children: 33 }), GRACE + 1))).toMatchObject([
      { limit: "children", value: 33, allowed: 32 },
    ]);
  });

  it("is not found in a type that raised its child limit to 64 and runs 48", () => {
    const watch = new ResourceWatch(limitsFor({ children: 64 }, personalLimits(undefined)));
    watch.observe(sample({ children: 48 }), 0);
    expect(watch.observe(sample({ children: 48 }), GRACE * 2)).toEqual([]);
  });

  it("of children over the person's default is acted on", () => {
    const watch = new ResourceWatch(limitsFor(undefined, PERSONAL));
    watch.observe(sample({ children: 5 }), 0);
    expect(acted(watch.observe(sample({ children: 5 }), GRACE + 1))).toMatchObject([
      { limit: "children", value: 5, allowed: 4 },
    ]);
  });

  it("is not judged from a reading the platform did not give, and keeps its clock", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ openFiles: 5000 }), 0);
    expect(acted(watch.observe(sample({ openFiles: null }), GRACE / 2))).toEqual([]);
    expect(acted(watch.observe(sample({ openFiles: 5000 }), GRACE + 1))).toHaveLength(1);
  });
});

describe("CPU", () => {
  const limits: ResourceLimits = {
    ...DEFAULT_LIMITS,
    cpuWindowMs: 100_000,
    cpuPercent: 40,
    graceMs: 0,
  };

  it("is unknown from one sample, and measured over the window from two totals", () => {
    const watch = new ResourceWatch(limits);
    // One sample: unknown, so never a breach, however high the total.
    expect(acted(watch.observe(sample({ cpuSeconds: 1000 }), 0))).toEqual([]);
    // 50 CPU seconds in 100 s: half a core, over the 40 % line from here on...
    expect(acted(watch.observe(sample({ cpuSeconds: 1050 }), 100_000))).toEqual([]);
    // ...and acted on one instant later, past a grace window of zero.
    const [breach] = watch.observe(sample({ cpuSeconds: 1050 }), 100_001);
    expect(breach).toMatchObject({ limit: "cpu" });
    expect(breach?.value).toBeCloseTo(50, 2);
    expect(acted(watch.observe(sample({ cpuSeconds: null }), 110_000))).toEqual([]);
  });

  it("inside the window cannot be hidden by a later idle sample", () => {
    const watch = new ResourceWatch({ ...limits, cpuPercent: 80 });
    watch.observe(sample({ cpuSeconds: 0 }), 0);
    // A burst of 95 s of CPU in the first 100 s, then idle for 10 s.
    watch.observe(sample({ cpuSeconds: 95 }), 100_000);
    // The sample from before the window's edge is kept: 95 s over 110 s, still over 80 %.
    const [breach] = watch.observe(sample({ cpuSeconds: 95 }), 110_000);
    expect(breach?.value).toBeCloseTo(86.36, 1);
  });

  it("a core and a half held past the grace window is acted on like any other breach", () => {
    const watch = new ResourceWatch(DEFAULT_LIMITS);
    watch.observe(sample({ cpuSeconds: 0 }), 0);
    watch.observe(sample({ cpuSeconds: 15 }), 10_000);
    expect(acted(watch.observe(sample({ cpuSeconds: 105 }), 70_001))).toMatchObject([
      { limit: "cpu", allowed: 90 },
    ]);
  });
});

describe("the words for a breach", () => {
  it("carry the numbers that triggered it", () => {
    expect(
      describeBreach({
        limit: "memory",
        value: 1300.4,
        allowed: 1024,
        durationMs: 61_000,
        sustained: true,
      }),
    ).toBe("memory 1300 MB, over its limit of 1024 MB, for 61 s");
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
