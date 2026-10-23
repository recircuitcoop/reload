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
import type { Notifier } from "../ports/notifier";
import type { LimitDefaultsSetting } from "../ports/settings-store";
import type { Cancel, Clock } from "../ports/clock";
import type {
  ProcessIdentity,
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
  /**
   * Send one signal to one pid (`process.kill`), for the strays below a stopped process; only
   * ever called just after that pid was read again and found to be the same process.
   */
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

/**
 * The person's own limits, from the settings file's `limits` (the old `[helper.defaults]`). A
 * setting that cannot be read is said, in the log and to the person with the file's name (the old
 * HelperConfigError), and the documented defaults are kept: a typo there must not stop Reload
 * from starting.
 */
export function readPersonalLimits(
  setting: LimitDefaultsSetting,
  logger: Logger,
  notifier?: Notifier,
): ResourceLimits {
  try {
    const limits = personalLimits(setting.readLimitDefaults());
    notifier?.clear("limits-unreadable", "limits");
    return limits;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    logger.error(`${why}; the documented resource limits are used instead`);
    notifier?.raise({ kind: "limits-unreadable", subject: "limits", detail: why });
    return personalLimits(undefined);
  }
}

/**
 * Whether two readings are one process: the same start time, and the same executable where both
 * reads could say (a read that could not name it does not make it someone else).
 */
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return (
    a.started === b.started &&
    (a.executable === null || b.executable === null || a.executable === b.executable)
  );
}

/** The pids among `entries` that host node processes. */
const hostsOf = (entries: readonly Entry[]): ReadonlySet<number> =>
  new Set(entries.filter((entry) => entry.target.hostsNodes === true).map((e) => e.target.pid));

/** How many reads in a row before a forced kill may fail before the kill is given up. */
export const KILL_CHECKS = 5;

/** One watched process, and what the watch knows of it. */
interface Entry {
  readonly target: WatchedProcess;
  /** A fresh judge per process: a restarted process gets its whole grace window again. */
  readonly judge: ResourceWatch;
  /** Who it was when first read; null until then. */
  identity: ProcessIdentity | null;
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
  /** When the last pass ended; null before the first. */
  let lastPass: number | null = null;
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

  /**
   * Read `entry` again just before a signal: its reading if it is still itself. A read that
   * failed is one failed pass ("unknown"): nothing is sent, and the entry is kept. Only a process
   * that is gone, or is someone else now, leaves the watch.
   */
  const check = async (entry: Entry): Promise<ProcessReading | "unknown" | "ended"> => {
    const { pid } = entry.target;
    let reading: ProcessReading | undefined;
    try {
      reading = (await deps.probe([pid], hostsOf([entry]))).get(pid);
    } catch (error) {
      log("error", `process ${String(pid)} could not be checked before a signal: ${String(error)}`);
      return ended(entry) ? "ended" : "unknown";
    }
    if (ended(entry)) {
      return "ended";
    }
    if (
      reading === undefined ||
      entry.identity === null ||
      !sameProcess(reading.identity, entry.identity)
    ) {
      log("warn", `process ${String(pid)} is gone or is another process now; nothing is sent`);
      drop(entry);
      return "ended";
    }
    return reading;
  };

  /** A signal that finds the process already gone has done what it was for. */
  const send = (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      deps.signal(pid, signal);
    } catch {
      // ESRCH: gone already
    }
  };

  /**
   * The strays below a stopped process (descendants that left its group, which a stop of the
   * group does not reach), as the old host's descendant sweep ended them (children.py
   * `_end_descendants`): asked politely now, and after the stop timeout read again and killed if
   * still themselves. This runs on even if the watch ends, since its process is gone by then.
   */
  const sweep = (strays: ProcessReading["strays"]): void => {
    if (strays.length === 0) {
      return;
    }
    log("warn", `stopping ${String(strays.length)} process(es) left running outside its group`);
    for (const stray of strays) {
      send(stray.pid, "SIGTERM");
    }
    deps.clock.after(deps.pace.stopTimeoutMs, () => {
      void deps
        .probe(strays.map((stray) => stray.pid))
        .then((readings) => {
          for (const stray of strays) {
            const now = readings.get(stray.pid)?.identity;
            if (now !== undefined && sameProcess(now, stray.identity)) {
              send(stray.pid, "SIGKILL");
            }
          }
        })
        .catch((error: unknown) => {
          log(
            "error",
            `the processes left outside its group could not be checked: ${String(error)}`,
          );
        });
    });
  };

  /** SIGKILL after the stop timeout, if it is still itself; a failed check tries again later. */
  const killLater = (entry: Entry, after: number, tries = 1): void => {
    entry.kill = deps.clock.after(after, () => {
      entry.kill = null;
      void (async () => {
        if (ended(entry)) {
          return;
        }
        const seen = await check(entry);
        if (typeof seen === "object") {
          log("warn", `process ${String(entry.target.pid)} did not stop when asked; ending it`);
          entry.target.kill();
          drop(entry);
        } else if (seen === "unknown" && tries < KILL_CHECKS) {
          killLater(entry, deps.pace.sampleEveryMs, tries + 1);
        } else if (seen === "unknown") {
          // The safe direction: a process that cannot be read is never killed by pid.
          log(
            "error",
            `process ${String(entry.target.pid)} could not be checked ${String(KILL_CHECKS)} ` +
              "times after it was asked to stop; no kill is sent, and it is no longer watched",
          );
          drop(entry);
        }
      })();
    });
  };

  const stop = async (entry: Entry, breaches: readonly Breach[]): Promise<void> => {
    const { target } = entry;
    const why = breaches.map(describeBreach).join("; ");
    entry.stopping = true;
    const seen = await check(entry);
    if (typeof seen !== "object") {
      // Unknown: sampled again next tick, its grace clock kept, so it is judged again then.
      entry.stopping = seen === "ended";
      return;
    }
    log("warn", `process ${String(target.pid)} is over its limits (${why}); stopping it politely`);
    target.stopped(why);
    target.stop();
    if (target.handleOnly !== true) {
      sweep(seen.strays);
    }
    if (!target.current()) {
      // Ended by its own stop (an Anytype's quit forces it itself): nothing left to kill.
      drop(entry);
      return;
    }
    killLater(entry, deps.pace.stopTimeoutMs);
  };

  const tick = async (): Promise<void> => {
    // A gap of more than two ticks between the end of the last pass and this one's start (a
    // sleep, a held event loop): nothing seen before it is known to have lasted through it, so
    // every grace window starts again. The time a pass itself takes is not a gap.
    const started = deps.clock.now();
    const gap = lastPass !== null && started - lastPass > 2 * deps.pace.sampleEveryMs;
    for (const entry of entries) {
      if (!entry.target.current()) {
        drop(entry);
      }
    }
    const sampled = [...entries].filter((entry) => !entry.stopping);
    let readings: ReadonlyMap<number, ProcessReading> = new Map();
    try {
      if (sampled.length > 0) {
        readings = await deps.probe(
          sampled.map((entry) => entry.target.pid),
          hostsOf(sampled),
        );
      }
    } catch (error) {
      log("error", `one pass of the resource watchdog failed: ${String(error)}`);
    }
    const now = deps.clock.now();
    for (const entry of sampled) {
      if (gap) {
        entry.judge.restart();
      }
      const reading = readings.get(entry.target.pid);
      if (ended(entry) || reading === undefined) {
        continue; // gone, or not measured: nothing is judged from no reading
      }
      if (entry.identity !== null && !sameProcess(entry.identity, reading.identity)) {
        log("warn", `process ${String(entry.target.pid)} is another process now; not watched`);
        drop(entry);
        continue;
      }
      entry.identity ??= reading.identity;
      const breaches = entry.judge.observe(reading.sample, now);
      for (const breach of breaches) {
        if (breach.durationMs === 0) {
          // Reported once as it starts: a spike inside the grace window is not acted on.
          log(
            "warn",
            `process ${String(entry.target.pid)} went over a limit: ${describeBreach(breach)}`,
          );
        }
      }
      const sustained = breaches.filter((breach) => breach.sustained);
      if (sustained.length > 0) {
        void stop(entry, sustained);
      }
    }
    lastPass = deps.clock.now();
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
