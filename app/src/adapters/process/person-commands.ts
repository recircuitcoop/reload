// A person's commands for one node instance from a terminal (`reload --start`, `--stop`,
// `--kill`, `--restart`, `--release`; the old helper's commands, cli.py): whether one applies to
// the instance as it is now, and why not.

import type { NodeVerb } from "../../ports/node-process";

export interface PersonFacts {
  readonly closing: boolean;
  /** Stopped for good: the crash-loop limit, or a type never restarted. */
  readonly stopped: boolean;
  /** Stopped by a person (`--stop`, `--kill`). */
  readonly paused: boolean;
  /** Being restarted by a person, or by its own restart after an exit. */
  readonly restarting: boolean;
  /** A process is there, possibly still exiting. */
  readonly process: boolean;
}

/** Why `verb` does not apply now; null when it does. */
export function verbRefusal(verb: NodeVerb, facts: PersonFacts): string | null {
  if (facts.closing) {
    return "it is closing";
  }
  if (verb === "release") {
    return facts.stopped ? null : "it is not stopped for good";
  }
  if (facts.stopped) {
    return "it is stopped for good; `reload --release` starts it again";
  }
  if (facts.restarting || (!facts.paused && !facts.process)) {
    return "it is restarting";
  }
  if (verb === "start") {
    return !facts.paused ? "it is already running" : facts.process ? "it is still stopping" : null;
  }
  return facts.paused ? "it is stopped" : null;
}
