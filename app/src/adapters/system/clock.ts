// The Clock port on the process's own timers.

import type { Cancel, Clock } from "../../ports/clock";

/**
 * The longest delay setTimeout keeps (2^31 - 1 ms, about 24.8 days). A longer one fires at once,
 * so a longer wait is made of several timers, each at most this long.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms: number, callback: () => void): Cancel {
    let timer: ReturnType<typeof setTimeout>;
    const wait = (left: number): void => {
      if (left > MAX_TIMER_MS) {
        timer = setTimeout(() => {
          wait(left - MAX_TIMER_MS);
        }, MAX_TIMER_MS);
        return;
      }
      timer = setTimeout(callback, left);
    };
    wait(ms);
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
