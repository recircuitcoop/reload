// What a node process is using, and whether it has used too much for too long (plan 0031 group
// A, kept from the old helper's detection.py:399-468 and its profile defaults).
//
// Each node process is watched against four limits: memory (RSS), CPU over a window, open files
// and child processes. A value over its line must stay over it for LONGER than the grace window
// before anything happens: a short spike is not a breach, and that is the whole reason the grace
// window exists (a node loading a model would otherwise be stopped on its first sample).
//
// What happens then differs by limit, which is the one change from the old helper the owner
// asked for (plan 0031): memory, open files and children over their grace window stop the
// process (politely, then forced) and it is restarted through the crash-loop breaker; CPU only
// warns, because a long job is legal and a busy process is not a broken one.
//
// CPU is a rate, so it is measured here from two totals: the cumulative CPU seconds of this
// sample and of the oldest sample still inside the window, over the time between them. Until two
// samples exist CPU is unknown, and an unknown value is never a breach. A reading the platform
// did not give (null) is not a reading of zero either: it is not judged, and its clock is kept.
//
// Pure: no I/O, no timers. The adapter measures (adapters/process/resource-probe.ts) and acts.

/** The limits one node process is watched against. */
export interface ResourceLimits {
  /** Resident memory, in MB. */
  readonly memoryMb: number;
  /** CPU over `cpuWindowMs`, as a percentage of one core: 150 is a core and a half. */
  readonly cpuPercent: number;
  readonly cpuWindowMs: number;
  readonly openFiles: number;
  /** Processes started by the node process, at any depth. */
  readonly children: number;
  /** How long a value may stay over its line before it is acted on (strictly longer). */
  readonly graceMs: number;
}

/**
 * The old helper's defaults (addons/manifest.py StabilityProfile, helper/config.py
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

/** What a package may declare under `reload.limits` (spec 2.3.5); every key is optional. */
export interface DeclaredLimits {
  readonly memory_mb?: number;
  readonly cpu_percent?: number;
  readonly cpu_window_s?: number;
  readonly open_files?: number;
  readonly children?: number;
  readonly grace_s?: number;
}

/** The limits in force: each declared value, and the default for each one left out. */
export function limitsFor(declared: DeclaredLimits | undefined): ResourceLimits {
  const seconds = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : value * 1000;
  return {
    memoryMb: declared?.memory_mb ?? DEFAULT_LIMITS.memoryMb,
    cpuPercent: declared?.cpu_percent ?? DEFAULT_LIMITS.cpuPercent,
    cpuWindowMs: seconds(declared?.cpu_window_s) ?? DEFAULT_LIMITS.cpuWindowMs,
    openFiles: declared?.open_files ?? DEFAULT_LIMITS.openFiles,
    children: declared?.children ?? DEFAULT_LIMITS.children,
    graceMs: seconds(declared?.grace_s) ?? DEFAULT_LIMITS.graceMs,
  };
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

/** One limit a process is over, and for how long, with the numbers that tell it. */
export interface Breach {
  readonly limit: Limit;
  readonly value: number;
  readonly allowed: number;
  /** Since the value went over its line; it starts again at zero once it comes back under. */
  readonly durationMs: number;
  /** Over for longer than the grace window: acted on (memory, files, children) or warned of. */
  readonly sustained: boolean;
}

/** What one sample says about a process. */
export interface Verdict {
  /** CPU over the window, in % of a core; null until two samples exist. */
  readonly cpuPercent: number | null;
  /** Every limit over its line right now, sustained or not. */
  readonly breaches: readonly Breach[];
  /** The sustained breaches that stop the process: never CPU. */
  readonly stop: readonly Breach[];
  /** Sustained CPU: told to the person, and the process left running. */
  readonly busy: Breach | null;
}

/** The judge of one node process's samples, stateful between them (grace and CPU windows). */
export class ResourceWatch {
  readonly #limits: ResourceLimits;
  /** The CPU samples still inside the window (and one from before it): [when, seconds]. */
  readonly #cpu: [number, number][] = [];
  /** When each limit now over its line first went over it. */
  readonly #overSince = new Map<Limit, number>();

  constructor(limits: ResourceLimits) {
    this.#limits = limits;
  }

  /** Judge one sample taken at `now`. */
  observe(sample: ResourceSample, now: number): Verdict {
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
      breaches.push({ limit, value, allowed, durationMs, sustained: durationMs > limits.graceMs });
    }
    const sustained = breaches.filter((breach) => breach.sustained);
    return {
      cpuPercent,
      breaches,
      stop: sustained.filter((breach) => breach.limit !== "cpu"),
      busy: sustained.find((breach) => breach.limit === "cpu") ?? null,
    };
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
