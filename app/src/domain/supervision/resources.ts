// What a managed process is using, and whether it has used too much for too long (plan 0031
// group A, kept from the old helper's detection.py:399-468, watch.py resolve_profile and the
// manifest's stability defaults).
//
// Each process is watched against four limits: memory (RSS), CPU over a window, open files and
// child processes. A value over its line must stay over it for LONGER than the grace window
// before anything happens: a short spike is not a breach, and that is the whole reason the grace
// window exists (a node loading a model would otherwise be stopped on its first sample). A
// sustained breach of any of the four stops the process, politely and then forced, as the old
// helper did; what comes back afterwards is the supervisor's restart policy, not this file's.
//
// CPU is a rate, so it is measured here from two totals: the cumulative CPU seconds of this
// sample and of the oldest sample still inside the window, over the time between them. Until two
// samples exist CPU is unknown, and an unknown value is never a breach. A reading the platform
// did not give (null) is not a reading of zero either: it is not judged, and its clock is kept.
//
// Pure: no I/O, no timers. An adapter measures (adapters/process/resource-probe.ts) and the
// watch acts (application/resource-watch.ts).

/** The limits one process is watched against. */
export interface ResourceLimits {
  /** Resident memory, in MB. */
  readonly memoryMb: number;
  /** CPU over `cpuWindowMs`, as a percentage of one core: 150 is a core and a half. */
  readonly cpuPercent: number;
  readonly cpuWindowMs: number;
  readonly openFiles: number;
  /** Processes started by the process, at any depth. */
  readonly children: number;
  /** How long a value may stay over its line before it is acted on (strictly longer). */
  readonly graceMs: number;
}

/**
 * The documented defaults (addons/manifest.py StabilityProfile, helper/config.py
 * DEFAULT_MAX_CHILDREN): 1 GB, 90 % over 2 minutes, 1024 files, 32 children, 60 s of grace.
 */
export const DEFAULT_LIMITS: ResourceLimits = {
  memoryMb: 1024,
  cpuPercent: 90,
  cpuWindowMs: 120_000,
  openFiles: 1024,
  children: 32,
  graceMs: 60_000,
};

/**
 * Limits as they are written: a type's `reload.limits` (spec 2.4.2), or the person's own
 * defaults under `limits` in the settings file (the old `[helper.defaults]`). Every key is
 * optional.
 */
export interface DeclaredLimits {
  readonly memory_mb?: number;
  readonly cpu_percent?: number;
  readonly cpu_window_s?: number;
  readonly open_files?: number;
  readonly children?: number;
  readonly grace_s?: number;
}

const NUMBERS = ["memory_mb", "cpu_percent", "cpu_window_s", "grace_s"] as const;
const COUNTS = ["open_files", "children"] as const;

/**
 * The largest limit Reload holds exactly. Not a policy (the old app had no upper bound): a larger
 * number, Infinity included, would not survive being written to the file and read back.
 */
const MAX_LIMIT = Number.MAX_SAFE_INTEGER;

/** What is wrong with one limit as written: not one we know, not above zero, not whole. */
export interface LimitProblem {
  readonly key: string;
  readonly problem: "not-a-limit" | "not-positive" | "not-whole" | "too-large";
}

/**
 * Every problem of `value` as a set of limits, field by field; null when it is not an object at
 * all. The old manifest's rules (manifest.py _optional_number, _optional_count, _check_fields):
 * every number greater than zero, the two counts whole numbers, no upper bound, and no key it
 * does not know.
 */
export function limitProblems(value: unknown): readonly LimitProblem[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const problems: LimitProblem[] = [];
  for (const [key, number] of Object.entries(value)) {
    const count = (COUNTS as readonly string[]).includes(key);
    if (!count && !(NUMBERS as readonly string[]).includes(key)) {
      problems.push({ key, problem: "not-a-limit" });
    } else if (typeof number !== "number" || !(number > 0)) {
      problems.push({ key, problem: count ? "not-whole" : "not-positive" });
    } else if (number > MAX_LIMIT) {
      problems.push({ key, problem: "too-large" });
    } else if (count && !Number.isInteger(number)) {
      problems.push({ key, problem: "not-whole" });
    }
  }
  return problems;
}

/** Why `value` is not a set of limits, in plain words, for a file; null when it is one. */
export function limitsProblem(value: unknown): string | null {
  const problems = limitProblems(value);
  if (problems === null) {
    return "must be an object of limits";
  }
  const [first] = problems;
  if (first === undefined) {
    return null;
  }
  switch (first.problem) {
    case "not-a-limit":
      return `${first.key} is not a limit (the limits are ${[...NUMBERS, ...COUNTS].join(", ")})`;
    case "too-large":
      return `${first.key} is larger than Reload can hold (at most ${String(MAX_LIMIT)})`;
    case "not-whole":
      return `${first.key} must be a whole number greater than zero`;
    case "not-positive":
      return `${first.key} must be a number greater than zero`;
  }
}

/** The limits in force, written as a declaration or the settings file writes them. */
export function declaredOf(limits: ResourceLimits): Required<DeclaredLimits> {
  return {
    memory_mb: limits.memoryMb,
    cpu_percent: limits.cpuPercent,
    cpu_window_s: limits.cpuWindowMs / 1000,
    open_files: limits.openFiles,
    children: limits.children,
    grace_s: limits.graceMs / 1000,
  };
}

const fromDeclared = (declared: DeclaredLimits): Partial<ResourceLimits> => {
  const ms = (seconds: number | undefined): number | undefined =>
    seconds === undefined ? undefined : seconds * 1000;
  const entries = Object.entries({
    memoryMb: declared.memory_mb,
    cpuPercent: declared.cpu_percent,
    cpuWindowMs: ms(declared.cpu_window_s),
    openFiles: declared.open_files,
    children: declared.children,
    graceMs: ms(declared.grace_s),
  }).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
};

/**
 * The limits in force for one type (spec 2.4.2 rule 3): a type that declared `reload` is a
 * profile, even one with no `limits` in it, so it gets the documented defaults and the person's
 * child limit; a type that declared none gets the person's defaults.
 */
export function typeLimits(
  reload: { readonly limits?: DeclaredLimits } | undefined,
  personal: ResourceLimits,
): ResourceLimits {
  return limitsFor(reload === undefined ? undefined : (reload.limits ?? {}), personal);
}

/** The person's own defaults: what the settings file sets, the documented defaults for the rest. */
export function personalLimits(settings: DeclaredLimits | undefined): ResourceLimits {
  return { ...DEFAULT_LIMITS, ...fromDeclared(settings ?? {}) };
}

/**
 * The limits in force for one process (watch.py resolve_profile). A type that declared no
 * `reload` is watched under the person's defaults. One that did gets what it declared, the
 * documented defaults for every other limit, and the person's child limit: `children` is the one
 * limit a declaration may leave to the person.
 */
export function limitsFor(
  declared: DeclaredLimits | undefined,
  personal: ResourceLimits = DEFAULT_LIMITS,
): ResourceLimits {
  if (declared === undefined) {
    return personal;
  }
  return { ...DEFAULT_LIMITS, children: personal.children, ...fromDeclared(declared) };
}

/** One reading of a process. A null field is one the platform could not measure. */
export interface ResourceSample {
  readonly memoryMb: number | null;
  /** Cumulative CPU time (user + system) since the process started. */
  readonly cpuSeconds: number | null;
  readonly openFiles: number | null;
  readonly children: number | null;
}

export type Limit = "memory" | "cpu" | "open-files" | "children";

/** One limit a process is over, with the numbers, and whether it has outlasted its grace. */
export interface Breach {
  readonly limit: Limit;
  readonly value: number;
  readonly allowed: number;
  /** Since the value went over its line; it starts again at zero once it comes back under. */
  readonly durationMs: number;
  /** Over for longer than the grace window: acted on. Inside it, only reported. */
  readonly sustained: boolean;
}

/** The most CPU samples one judge keeps, whatever its window. */
export const MAX_CPU_SAMPLES = 1000;

/** The judge of one process's samples, stateful between them (grace and CPU windows). */
export class ResourceWatch {
  readonly #limits: ResourceLimits;
  /** The CPU samples still inside the window (and one from before it): [when, seconds]. */
  readonly #cpu: [number, number][] = [];
  /** When each limit now over its line first went over it. */
  readonly #overSince = new Map<Limit, number>();

  constructor(limits: ResourceLimits) {
    this.#limits = limits;
  }

  /** Judge one sample taken at `now`: every limit over its line, sustained or not. */
  observe(sample: ResourceSample, now: number): readonly Breach[] {
    const limits = this.#limits;
    const cpuPercent = this.#cpuOverWindow(sample.cpuSeconds, now);
    const readings: [Limit, number | null, number][] = [
      ["memory", sample.memoryMb, limits.memoryMb],
      ["cpu", cpuPercent, limits.cpuPercent],
      ["open-files", sample.openFiles, limits.openFiles],
      ["children", sample.children, limits.children],
    ];
    const breaches: Breach[] = [];
    for (const [limit, value, allowed] of readings) {
      if (value === null) {
        // Not read this time: not observed under its line either, so its clock is kept.
        continue;
      }
      if (value <= allowed) {
        this.#overSince.delete(limit);
        continue;
      }
      const since = this.#overSince.get(limit) ?? now;
      this.#overSince.set(limit, since);
      const durationMs = now - since;
      // Strictly longer than the grace window: exactly as long is still a spike.
      breaches.push({ limit, value, allowed, durationMs, sustained: durationMs > limits.graceMs });
    }
    return breaches;
  }

  /**
   * The watch could not look for a while (the machine slept, the event loop was held): a value
   * seen over its line before the gap is not known to have stayed over through it, so every
   * grace window starts again, and CPU is measured afresh.
   */
  restart(): void {
    this.#overSince.clear();
    this.#cpu.length = 0;
  }

  #cpuOverWindow(seconds: number | null, now: number): number | null {
    if (seconds === null) {
      return null;
    }
    const samples = this.#cpu;
    samples.push([now, seconds]);
    // Keep one sample from before the window's edge: dropping it would shorten the window to
    // the newest sample and let a later idle sample hide a burst inside the window.
    const cutoff = now - this.#limits.cpuWindowMs;
    while (samples.length > 1 && (samples[1]?.[0] ?? now) <= cutoff) {
      samples.shift();
    }
    // shortcut: at most MAX_CPU_SAMPLES are kept, so a window longer than that many samples
    // (2.8 hours at one every 10 s) is measured over that span; enough for any limit seen so far.
    if (samples.length > MAX_CPU_SAMPLES) {
      samples.splice(0, samples.length - MAX_CPU_SAMPLES);
    }
    const [oldestAt, oldestSeconds] = samples[0] ?? [now, seconds];
    const elapsedMs = now - oldestAt;
    if (elapsedMs <= 0) {
      return null;
    }
    return ((seconds - oldestSeconds) * 1000 * 100) / elapsedMs;
  }
}

const WHAT: Record<Limit, string> = {
  memory: "memory",
  cpu: "CPU",
  "open-files": "open files",
  children: "child processes",
};
const UNIT: Record<Limit, string> = { memory: " MB", cpu: " %", "open-files": "", children: "" };

/** A breach with its numbers: "memory 1300 MB, over its limit of 1024 MB, for 61 s". */
export function describeBreach(breach: Breach): string {
  const unit = UNIT[breach.limit];
  const value = `${String(Math.round(breach.value))}${unit}`;
  const allowed = `${String(Math.round(breach.allowed))}${unit}`;
  const seconds = String(Math.round(breach.durationMs / 1000));
  return `${WHAT[breach.limit]} ${value}, over its limit of ${allowed}, for ${seconds} s`;
}
