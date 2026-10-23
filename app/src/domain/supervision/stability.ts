// The supervision numbers a person may change (plan 0032 group 9; the old helper form's
// `tick`, `stop_timeout`, `restart_attempts`, `restart_backoff`, `breaker_window` and
// `breaker_interventions`): the `stability` setting in shell-settings.json, beside `limits`.
//
// As written, in seconds and counts like the old config.toml; in force, in milliseconds, for the
// shell's supervisor, the runtime's node processes and the services process's MCP child alike.
// Every key is optional: one left out is the documented default.

import { DEFAULT_BACKOFF, type BackoffSettings } from "./backoff";
import { DEFAULT_CRASH_LOOP, type CrashLoopSettings } from "./breaker";

/** The `stability` setting as written: every key optional. */
export interface DeclaredStability {
  /** The delay before each restart in a row, in seconds; the last one repeats. */
  readonly restart_backoff_s?: readonly number[];
  /** How often the resource watchdog looks at every process, in seconds. */
  readonly check_s?: number;
  /** How long a process asked to stop has before it is killed, in seconds. */
  readonly stop_timeout_s?: number;
  /** How many restarts in a row, without the process coming up between, before Reload stops. */
  readonly restart_attempts?: number;
  /** The crash-loop limit's window, in seconds. */
  readonly breaker_window_s?: number;
  /** The crash-loop limit's count: this many crashes inside the window, and no more restarts. */
  readonly breaker_count?: number;
}

/** The numbers in force. */
export interface Stability {
  readonly backoff: BackoffSettings;
  readonly checkEveryMs: number;
  readonly stopTimeoutMs: number;
  readonly restartAttempts: number;
  readonly crashLoop: CrashLoopSettings;
}

/** The old helper's tick and stop timeout (10 s each) and its five restart attempts. */
export const DEFAULT_STABILITY: Stability = {
  backoff: DEFAULT_BACKOFF,
  checkEveryMs: 10_000,
  stopTimeoutMs: 10_000,
  restartAttempts: 5,
  crashLoop: DEFAULT_CRASH_LOOP,
};

const NUMBERS = ["check_s", "stop_timeout_s", "breaker_window_s"] as const;
const COUNTS = ["restart_attempts", "breaker_count"] as const;
const LIST = "restart_backoff_s";

/** Every key of the setting, in the form's order. */
export const STABILITY_KEYS: readonly (keyof DeclaredStability)[] = [
  "check_s",
  "stop_timeout_s",
  "restart_attempts",
  LIST,
  "breaker_window_s",
  "breaker_count",
];

/**
 * The longest a timer can wait (Node's setTimeout, 2^31 - 1 ms), in seconds: a longer one would
 * fire at once, and a check every millisecond is what this bound is for.
 */
const MAX_SECONDS = Math.floor(2_147_483_647 / 1000);
/** The largest count Reload holds exactly. */
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

/** What is wrong with one key as written; the words of resources.ts LimitProblem, and a list's. */
export interface StabilityProblem {
  readonly key: string;
  readonly problem: "not-a-limit" | "not-positive" | "not-whole" | "too-large" | "not-a-list";
}

/**
 * Every problem of `value` as a `stability` setting, key by key; null when it is not an object.
 * The old form's rules: every number above zero, the two counts whole, the delays a list of at
 * least one number above zero, and no key it does not know.
 */
export function stabilityProblems(value: unknown): readonly StabilityProblem[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const problems: StabilityProblem[] = [];
  for (const [key, given] of Object.entries(value)) {
    const problem = keyProblem(key, given);
    if (problem !== null) {
      problems.push({ key, problem });
    }
  }
  return problems;
}

function keyProblem(key: string, given: unknown): StabilityProblem["problem"] | null {
  if (key === LIST) {
    const delays = Array.isArray(given) ? (given as unknown[]) : [];
    if (delays.length === 0 || delays.some((one) => typeof one !== "number" || !(one > 0))) {
      return "not-a-list";
    }
    return (delays as number[]).some((one) => one > MAX_SECONDS) ? "too-large" : null;
  }
  const count = (COUNTS as readonly string[]).includes(key);
  if (!count && !(NUMBERS as readonly string[]).includes(key)) {
    return "not-a-limit";
  }
  if (typeof given !== "number" || !(given > 0)) {
    return count ? "not-whole" : "not-positive";
  }
  if (given > (count ? MAX_COUNT : MAX_SECONDS)) {
    return "too-large";
  }
  return count && !Number.isInteger(given) ? "not-whole" : null;
}

/** Why `value` is not a `stability` setting, in plain words, for a file; null when it is one. */
export function stabilityProblem(value: unknown): string | null {
  const problems = stabilityProblems(value);
  if (problems === null) {
    return "must be an object of supervision numbers";
  }
  const [first] = problems;
  if (first === undefined) {
    return null;
  }
  switch (first.problem) {
    case "not-a-limit":
      return `${first.key} is not one of them (they are ${STABILITY_KEYS.join(", ")})`;
    case "too-large":
      return `${first.key} is larger than Reload can wait or count`;
    case "not-whole":
      return `${first.key} must be a whole number greater than zero`;
    case "not-positive":
      return `${first.key} must be a number greater than zero`;
    case "not-a-list":
      return `${first.key} must be a list of seconds, each greater than zero`;
  }
}

/** The numbers in force: what the setting says, the documented defaults for the rest. */
export function stabilityOf(declared: DeclaredStability | undefined): Stability {
  const given = declared ?? {};
  const ms = (seconds: number | undefined, fallback: number): number =>
    seconds === undefined ? fallback : seconds * 1000;
  return {
    backoff:
      given.restart_backoff_s === undefined
        ? DEFAULT_STABILITY.backoff
        : { delaysMs: given.restart_backoff_s.map((seconds) => seconds * 1000) },
    checkEveryMs: ms(given.check_s, DEFAULT_STABILITY.checkEveryMs),
    stopTimeoutMs: ms(given.stop_timeout_s, DEFAULT_STABILITY.stopTimeoutMs),
    restartAttempts: given.restart_attempts ?? DEFAULT_STABILITY.restartAttempts,
    crashLoop: {
      maxCrashes: given.breaker_count ?? DEFAULT_STABILITY.crashLoop.maxCrashes,
      windowMs: ms(given.breaker_window_s, DEFAULT_STABILITY.crashLoop.windowMs),
    },
  };
}

/** The numbers in force, written as the setting writes them. */
export function declaredStabilityOf(stability: Stability): Required<DeclaredStability> {
  return {
    restart_backoff_s: stability.backoff.delaysMs.map((ms) => ms / 1000),
    check_s: stability.checkEveryMs / 1000,
    stop_timeout_s: stability.stopTimeoutMs / 1000,
    restart_attempts: stability.restartAttempts,
    breaker_window_s: stability.crashLoop.windowMs / 1000,
    breaker_count: stability.crashLoop.maxCrashes,
  };
}
