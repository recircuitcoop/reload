// Time, injected: a backoff, a crash window or a call timeout is something a test moves
// through rather than waits out.

/** Cancels a scheduled callback; calling it after the callback ran does nothing. */
export type Cancel = () => void;

export interface Clock {
  /** Milliseconds, monotonic enough to measure a window with. */
  now(): number;
  /**
   * Milliseconds that only ever go forward, whatever the wall clock is set to; absent, now().
   * What a silence is measured on: setting the clock back must not pause a judgement.
   */
  monotonic?(): number;
  /** Run `callback` once, `ms` from now. */
  after(ms: number, callback: () => void): Cancel;
}
