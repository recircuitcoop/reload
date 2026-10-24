// Whether a crashed child should be restarted at all (plan 0018 §3, `helper/breaker.py`).
//
// The backoff answers *when*; this answers *whether any more*. A child that crashes on a
// corrupt file would otherwise be restarted for as long as the machine is on: a loop that
// burns a laptop and tells nobody anything.
//
// The rule is N crashes inside a window (defaults 5 in 10 minutes, the old helper's breaker;
// the person may change both, plan 0032 group 9). Counting inside a window
// rather than for all time is what tells "this is broken" from "this had a bad day": a child
// that fails once a week is never stopped, one that fails five times in a minute is.
//
// Tripping is a state, not a punishment: the supervisor stops restarting and tells the
// person, who can start the child again. `reset` is that start, and it forgets the counted
// crashes too, or the next hiccup would trip it again at once.

/** The crash-loop limit's two numbers. */
import { crashRestartDelay, type BackoffSettings } from "./backoff";

export interface CrashLoopSettings {
  /** This many crashes inside the window trips the breaker. */
  readonly maxCrashes: number;
  /** How far back a crash still counts. */
  readonly windowMs: number;
}

export const DEFAULT_CRASH_LOOP: CrashLoopSettings = { maxCrashes: 5, windowMs: 600_000 };

/**
 * The resource watchdog's own limit (helper/config.py BreakerSettings): five stops over a limit
 * in ten minutes, and the process is not started again. Its own numbers, not the crash-loop
 * limit's: a person who narrows that window must not make five slow stops uncountable.
 */
export const DEFAULT_INTERVENTIONS: CrashLoopSettings = { maxCrashes: 5, windowMs: 600_000 };

export class CrashLoopBreaker {
  readonly #settings: CrashLoopSettings;
  readonly #now: () => number;
  #crashes: number[] = [];
  #tripped = false;

  /** `now` is the supervisor's clock, injected, so a test moves through a window. */
  constructor(settings: CrashLoopSettings, now: () => number) {
    this.#settings = settings;
    this.#now = now;
  }

  /**
   * Count one crash. True while restarting is still allowed; false once the limit is reached.
   *
   * Counting and asking are one call on purpose: a caller that counted without asking, or
   * asked without counting, is the bug this shape prevents.
   */
  recordCrash(): boolean {
    if (this.#tripped) {
      return false;
    }
    const at = this.#now();
    this.#crashes = [...this.#recent(at), at];
    if (this.#crashes.length >= this.#settings.maxCrashes) {
      this.#tripped = true;
      return false;
    }
    return true;
  }

  /** Whether the limit was reached, so restarting has stopped. */
  get tripped(): boolean {
    return this.#tripped;
  }

  /** The crashes still inside the window. */
  crashesInWindow(): number {
    return this.#recent(this.#now()).length;
  }

  /** A person started the child again: restarting resumes and the counted crashes go. */
  reset(): void {
    this.#tripped = false;
    this.#crashes = [];
  }

  /** Old crashes are dropped on every read, not on a timer: the window is a fact about time. */
  #recent(at: number): number[] {
    const cutoff = at - this.#settings.windowMs;
    return this.#crashes.filter((crash) => crash > cutoff);
  }
}

/**
 * The crash-loop limit and the restart attempts together (plan 0032 group 9; the old helper's
 * breaker and restart.max_attempts): a crash counts against both, and either one stops the
 * restarts. Read as the crash-loop settings it was made with, and says which one stopped it.
 */
export class RestartLimit implements CrashLoopSettings {
  readonly #breaker: CrashLoopBreaker;
  readonly #settings: CrashLoopSettings;
  readonly #attempts: number;
  #inARow = 0;

  constructor(
    settings: { readonly crashLoop: CrashLoopSettings; readonly restartAttempts: number },
    now: () => number,
  ) {
    this.#settings = settings.crashLoop;
    this.#attempts = settings.restartAttempts;
    this.#breaker = new CrashLoopBreaker(settings.crashLoop, now);
  }

  get maxCrashes(): number {
    return this.#settings.maxCrashes;
  }

  get windowMs(): number {
    return this.#settings.windowMs;
  }

  /** Count one crash. True while restarting is still allowed by both. */
  recordCrash(): boolean {
    this.#inARow += 1;
    return this.#breaker.recordCrash() && this.#inARow <= this.#attempts;
  }

  /** The process came up: the crashes in a row start again from none. */
  ready(): void {
    this.#inARow = 0;
  }

  /** The crashes since the process last came up. */
  get inARow(): number {
    return this.#inARow;
  }

  /** The wait before the restart this crash allowed: the delay of its place in the row. */
  delay(backoff: BackoffSettings): number {
    return crashRestartDelay(Math.max(1, this.#inARow), backoff);
  }

  /** Why the restarts stopped when the attempts stopped them, in words; null otherwise. */
  get overAttempts(): string | null {
    return !this.#breaker.tripped && this.#inARow > this.#attempts
      ? `stopped after ${String(this.#inARow)} exits in a row`
      : null;
  }
}
