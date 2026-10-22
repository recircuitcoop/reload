// The Clock port on the process's own timers.

import type { Cancel, Clock } from "../../ports/clock";

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  after(ms: number, callback: () => void): Cancel {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * The same timers, on a clock that only moves while the machine is awake and never jumps with a
 * change of the wall clock: what a grace window is measured on (plan 0031), so a sleep is not
 * read as time spent over a limit.
 */
export const monotonicClock: Clock = {
  now: () => performance.now(),
  after: (ms, callback) => systemClock.after(ms, callback),
};
