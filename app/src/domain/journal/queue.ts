// The bound on one instance's outstanding inputs (spec 7.6). The spike had none.
//
// Outstanding means journaled and not yet done. At the bound a further input is either held,
// at the upstream wire, until one finishes, or failed with `done(err)` "queue full"; which
// one is a runtime setting, and so is the bound. Either way it is reported, never dropped.
// Held inputs have a bound of their own, far above it, since an instance waiting on a person
// may rightly hold many: past it the instance is cut off and every input fails until it
// finishes one (adapters/process/input-journal.ts).

/** What happens to an input that arrives at the bound. */
export type QueuePolicy = "hold" | "fail";

export interface QueueSettings {
  /** The most inputs one instance may have outstanding. */
  readonly bound: number;
  readonly policy: QueuePolicy;
  /** The most inputs held at the bound before the instance is cut off; absent, HELD_BOUND. */
  readonly held?: number;
}

/** The held inputs' bound: what one instance may keep waiting in memory (spec 7.6). */
export const HELD_BOUND = 1024;

export const DEFAULT_QUEUE: QueueSettings = { bound: 64, policy: "hold" };

/** The settings, checked: a bound that is not a whole number of at least 1 is refused. */
export function queueSettings(
  bound: number,
  policy: QueuePolicy,
  held: number = HELD_BOUND,
): QueueSettings {
  for (const value of [bound, held]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`a queue bound must be a whole number of at least 1, not ${String(value)}`);
    }
  }
  return { bound, policy, held };
}

/** What to do with an arriving input when `outstanding` inputs are already journaled. */
export function admit(outstanding: number, settings: QueueSettings): "send" | QueuePolicy {
  return outstanding < settings.bound ? "send" : settings.policy;
}

/** One instance's queue, for the log. */
export interface QueueReport {
  readonly instanceId: string;
  /** Journaled, not yet done. */
  readonly outstanding: number;
  /** Held at the bound, not yet journaled (policy `hold`). */
  readonly held: number;
  /** Failed with "queue full" since the instance started (policy `fail`). */
  readonly refused: number;
  readonly bound: number;
  readonly policy: QueuePolicy;
}
