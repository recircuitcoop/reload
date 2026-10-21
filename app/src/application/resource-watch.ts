// The resource watchdog of one managed process (plan 0031 group A; the old helper's tick,
// detection.py HealthWatch, and processes.py's polite stop then kill).
//
// Every `sampleEveryMs` one read of the process table measures every watched process, and the
// domain judges each sample (domain/supervision/resources.ts). A sustained breach stops it
// politely, then forced after `stopTimeoutMs`. Before each signal the process is read again, and
// nothing is sent unless it is still the process first read: the same pid, start time and
// executable (children.py's identity check), so a pid the system reused is never signalled. Whoever runs the process decides what comes
// back: a node process and the runtime and services processes are restarted through their
// crash-loop breaker, so the stop counts as one exit like any other; an Anytype Reload started is
// not started again. Only the process it was given is ever stopped: an adopted Anytype is never
// handed to it.
//
// A pass that fails (the probe threw) is logged, nothing is judged from it, and the next one is
// still taken; a process that went between two reads is simply not judged that pass.

import {
  describeBreach,
  personalLimits,
  ResourceWatch,
  type Breach,
  type ResourceLimits,
} from "../domain/supervision/resources";
import type { Logger } from "../ports/logger";
import type { LimitDefaultsSetting } from "../ports/settings-store";
import type { Cancel, Clock } from "../ports/clock";
import type {
  ProcessReading,
  ResourceProbe,
  ResourceWatchdog,
  WatchedProcess,
} from "../ports/resource-watch";

/** The pace of the watchdog: the old helper's `tick` and `stop_timeout`. */
export interface WatchPace {
  readonly sampleEveryMs: number;
  readonly stopTimeoutMs: number;
}

export const DEFAULT_WATCH_PACE: WatchPace = { sampleEveryMs: 10_000, stopTimeoutMs: 10_000 };

export interface WatchDeps {
  readonly probe: ResourceProbe;
  readonly clock: Clock;
  readonly pace: WatchPace;
  readonly log: (level: "warn" | "error", message: string) => void;
}

/**
 * The person's own limits, from the settings file's `limits` (the old `[helper.defaults]`). A
 * setting that cannot be read is said, and the documented defaults are kept: a typo there must
 * not stop Reload from starting.
 */
export function readPersonalLimits(setting: LimitDefaultsSetting, logger: Logger): ResourceLimits {
  try {
    return personalLimits(setting.readLimitDefaults());
  } catch (error) {
    logger.error(`${String(error)}; the documented resource limits are used instead`);
    return personalLimits(undefined);
  }
}

/** One watched process, and what the watch knows of it. */
interface Entry {
  readonly target: WatchedProcess;
  /** A fresh judge per process: a restarted process gets its whole grace window again. */
  readonly judge: ResourceWatch;
  /** Who it was when first read; null until then. */
  identity: string | null;
  /** Being stopped: no longer sampled, and its kill (if any) scheduled. */
  stopping: boolean;
  kill: Cancel | null;
}

/**
 * The watchdog every managed process of one process tree is handed to. One tick samples them
 * all, with one read of the process table (the old helper's HealthWatch.tick).
 */
export function resourceWatchdog(deps: WatchDeps): ResourceWatchdog {
  const entries = new Set<Entry>();
  let timer: Cancel | null = null;
  const log = deps.log;

  const ended = (entry: Entry): boolean => !entries.has(entry) || !entry.target.current();
  const drop = (entry: Entry): void => {
    entry.kill?.();
    entries.delete(entry);
    if (entries.size === 0) {
      timer?.();
      timer = null;
    }
  };
  const schedule = (): void => {
    if (timer === null && entries.size > 0) {
      timer = deps.clock.after(deps.pace.sampleEveryMs, () => {
        timer = null;
        void tick();
      });
    }
  };

  /** Read `entry` again just before a signal: false (and dropped) unless it is still itself. */
  const stillItself = async (entry: Entry): Promise<boolean> => {
    const { pid } = entry.target;
    let identity: string | undefined;
    try {
      identity = (await deps.probe([pid])).get(pid)?.identity;
    } catch (error) {
      log("error", `process ${String(pid)} could not be checked before a signal: ${String(error)}`);
    }
    if (ended(entry)) {
      return false;
    }
    if (identity === undefined || identity !== entry.identity) {
      log("warn", `process ${String(pid)} is gone or is another process now; nothing is sent`);
      drop(entry);
      return false;
    }
    return true;
  };

  const stop = async (entry: Entry, breaches: readonly Breach[]): Promise<void> => {
    const { target } = entry;
    const why = breaches.map(describeBreach).join("; ");
    entry.stopping = true;
    if (!(await stillItself(entry))) {
      return;
    }
    log("warn", `process ${String(target.pid)} is over its limits (${why}); stopping it politely`);
    target.stopped(why);
    target.stop();
    entry.kill = deps.clock.after(deps.pace.stopTimeoutMs, () => {
      entry.kill = null;
      void (async () => {
        if (!ended(entry) && (await stillItself(entry))) {
          log("warn", `process ${String(target.pid)} did not stop when asked; ending it`);
          target.kill();
        }
        drop(entry);
      })();
    });
  };

  const tick = async (): Promise<void> => {
    for (const entry of entries) {
      if (!entry.target.current()) {
        drop(entry);
      }
    }
    const sampled = [...entries].filter((entry) => !entry.stopping);
    let readings: ReadonlyMap<number, ProcessReading> = new Map();
    try {
      if (sampled.length > 0) {
        readings = await deps.probe(sampled.map((entry) => entry.target.pid));
      }
    } catch (error) {
      log("error", `one pass of the resource watchdog failed: ${String(error)}`);
    }
    const now = deps.clock.now();
    for (const entry of sampled) {
      const reading = readings.get(entry.target.pid);
      if (ended(entry) || reading === undefined) {
        continue; // gone, or not measured: nothing is judged from no reading
      }
      if (entry.identity !== null && entry.identity !== reading.identity) {
        log("warn", `process ${String(entry.target.pid)} is another process now; not watched`);
        drop(entry);
        continue;
      }
      entry.identity = reading.identity;
      const breaches = entry.judge.observe(reading.sample, now);
      if (breaches.length > 0) {
        void stop(entry, breaches);
      }
    }
    schedule();
  };

  return (target) => {
    const entry: Entry = {
      target,
      judge: new ResourceWatch(target.limits),
      identity: null,
      stopping: false,
      kill: null,
    };
    entries.add(entry);
    schedule();
    return () => {
      drop(entry);
    };
  };
}
