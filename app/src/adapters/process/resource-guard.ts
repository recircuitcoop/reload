// A node instance's side of the resource watchdog (plan 0031 group A), apart from
// node-process.ts so that file stays under the 600-line limit (plan 0018 §2.3).
//
// Each process the instance spawns is handed to the watchdog with its type's limits, and is
// stopped through its own process group: SIGTERM, then SIGKILL. Its exit is then an unexpected
// exit like any other, counted by the crash-loop breaker. The stops are also counted by their
// own breaker (helper/config.py BreakerSettings: five in ten minutes), because a stop takes at
// least the grace window and the crash-loop limit could never see five: at that limit the
// instance is not started again until it is redeployed.
//
// The person is told once per episode: "started it again" when the next process starts after
// the first stop in the window, and node-stopped, in the breaker's words, at its limit.

import {
  CrashLoopBreaker,
  DEFAULT_INTERVENTIONS,
  type CrashLoopSettings,
} from "../../domain/supervision/breaker";
import { DEFAULT_LIMITS } from "../../domain/supervision/resources";
import type { NodeProcessSpec } from "../../ports/node-process";
import type { NodeProcessDeps } from "./node-process-settings";

export class NodeResourceGuard {
  readonly #spec: NodeProcessSpec;
  readonly #deps: NodeProcessDeps;
  readonly #interventions: CrashLoopBreaker;
  /** Why the last process was stopped, until the next one has started; told once an episode. */
  #stoppedFor: string | null = null;
  /** The words for the instance's end once the stops reached their limit; null before. */
  #forGood: string | null = null;

  constructor(spec: NodeProcessSpec, deps: NodeProcessDeps) {
    this.#spec = spec;
    this.#deps = deps;
    this.#interventions = new CrashLoopBreaker(DEFAULT_INTERVENTIONS, () => deps.clock.now());
  }

  /** False once the stops over a limit reached their limit: the next exit is the last. */
  get restartable(): boolean {
    return this.#forGood === null;
  }

  /** Why the instance is not started again, in the crash-loop notice's words. */
  stopText({ maxCrashes, windowMs }: CrashLoopSettings): string {
    return (
      this.#forGood ?? `stopped after ${String(maxCrashes)} exits in ${String(windowMs / 1000)} s`
    );
  }

  #stopping(why: string): void {
    const first = this.#interventions.crashesInWindow() === 0;
    if (!this.#interventions.recordCrash()) {
      const { maxCrashes, windowMs } = DEFAULT_INTERVENTIONS;
      this.#forGood =
        `stopped after going over its resource limits ${String(maxCrashes)} times in ` +
        `${String(windowMs / 60_000)} minutes (the last: ${why})`;
      this.#stoppedFor = null;
      return;
    }
    // Told once an episode: a node stopped again within the window is the same news.
    this.#stoppedFor = first ? why : null;
  }

  /**
   * A process of this instance started: watched, and told of if it replaces a stopped one. The
   * Cancel ends its watch: the instance cancels it with its own timers, on exit and on close.
   */
  watch(pid: number | undefined, current: () => boolean): () => void {
    const { identity } = this.#spec;
    if (this.#stoppedFor !== null && pid !== undefined) {
      const name =
        identity.name === "" ? identity.typeId : `"${identity.name}" (${identity.typeId})`;
      // Keyed by the instance id: two unnamed nodes of one type are two notices.
      this.#deps.notifier.raise({
        kind: "node-over-limit",
        subject: identity.id,
        detail: `The node ${name} used ${this.#stoppedFor}, so Reload stopped it and started it again`,
      });
      this.#stoppedFor = null;
    }
    const watchdog = this.#deps.watchdog;
    if (watchdog === undefined || pid === undefined) {
      return () => undefined;
    }
    return watchdog({
      pid,
      limits: this.#spec.limits ?? DEFAULT_LIMITS,
      stop: () => {
        this.#deps.tree.stop(pid);
      },
      kill: () => {
        this.#deps.tree.kill(pid);
      },
      current,
      stopped: (why) => {
        this.#stopping(why);
      },
    });
  }
}
