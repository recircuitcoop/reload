// The resource watchdog of one managed process (plan 0031 group A; the old helper's tick,
// detection.py HealthWatch, and processes.py's polite stop then kill).
//
// Every `sampleEveryMs` the probe measures the process and the domain judges the sample
// (domain/supervision/resources.ts). A sustained breach stops it politely, then forced after
// `stopTimeoutMs` if it is still the same process. Whoever runs the process decides what comes
// back: a node process and the runtime and services processes are restarted through their
// crash-loop breaker, so the stop counts as one exit like any other; an Anytype Reload started is
// not started again. Only the process it was given is ever stopped: an adopted Anytype is never
// handed to it.
//
// A sample that fails (the probe threw, the process went between two reads) is one failed
// sample: it is logged, nothing is judged from it, and the next one is still taken.

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
import type { ResourceProbe, ResourceWatchdog, WatchedProcess } from "../ports/resource-watch";

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

/** The watchdog every managed process of one process tree is handed to. */
export function resourceWatchdog(deps: WatchDeps): ResourceWatchdog {
  return (target) => watch(target, deps);
}

function watch(target: WatchedProcess, deps: WatchDeps): Cancel {
  const { pid } = target;
  let ended = false;
  // One thing is ever scheduled at a time: the next sample, or the kill after a polite stop.
  let pending: Cancel | null = null;
  const after = (ms: number, callback: () => void): void => {
    pending = deps.clock.after(ms, callback);
  };
  const current = (): boolean => !ended && target.current();
  // A fresh judge per process: a restarted process gets its whole grace window again.
  const judge = new ResourceWatch(target.limits);

  const stop = (breaches: readonly Breach[]): void => {
    const why = breaches.map(describeBreach).join("; ");
    deps.log("warn", `process ${String(pid)} is over its limits (${why}); stopping it politely`);
    target.stopped(why);
    target.stop();
    after(deps.pace.stopTimeoutMs, () => {
      if (current()) {
        deps.log("warn", `process ${String(pid)} did not stop when asked; ending it`);
        target.kill();
      }
    });
  };

  const sample = async (): Promise<void> => {
    let breaches: readonly Breach[] = [];
    try {
      const reading = await deps.probe(pid);
      breaches = reading === null ? [] : judge.observe(reading, deps.clock.now());
    } catch (error) {
      deps.log("error", `one sample of process ${String(pid)} failed: ${String(error)}`);
    }
    if (!current()) {
      return;
    }
    if (breaches.length > 0) {
      stop(breaches);
      return; // its exit ends this watch; a process that comes back gets its own
    }
    after(deps.pace.sampleEveryMs, () => void sample());
  };
  after(deps.pace.sampleEveryMs, () => void sample());
  return () => {
    ended = true;
    pending?.();
  };
}
