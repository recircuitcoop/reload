// When a crashed child comes back (plan 0018 §3, `helper/restart.py`; spec 10.6).
//
// The old helper's rule, kept (plan 0032 group 9): a delay list, the n-th crash in a row waits
// the n-th delay, and the last one repeats once the crashes outlast the list (config.py
// RestartSettings). A delay is a number the supervisor schedules on its clock, never a sleep.

/** The backoff rule's delays; a setting (stability.ts), so none lives as a literal in a supervisor. */
export interface BackoffSettings {
  /** The wait before the 1st, 2nd, ... restart in a row; at least one, the last repeating. */
  readonly delaysMs: readonly number[];
}

/** The old helper's defaults: 1, 2, 4, 8 and 16 seconds. */
export const DEFAULT_BACKOFF: BackoffSettings = { delaysMs: [1_000, 2_000, 4_000, 8_000, 16_000] };

/**
 * The wait before restarting after the n-th crash in a row (n starts at 1).
 *
 * "In a row" is the supervisor's count of crashes since the child was last `ready`; a child
 * that came up and ran resets it.
 */
export function crashRestartDelay(
  consecutiveCrashes: number,
  settings: BackoffSettings = DEFAULT_BACKOFF,
): number {
  if (!Number.isInteger(consecutiveCrashes) || consecutiveCrashes < 1) {
    throw new RangeError(`a crash count starts at 1, not ${String(consecutiveCrashes)}`);
  }
  const { delaysMs } = settings;
  return delaysMs[Math.min(consecutiveCrashes, delaysMs.length) - 1] ?? 0;
}
