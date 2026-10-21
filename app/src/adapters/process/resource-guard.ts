// A node instance's side of the resource watchdog (plan 0031 group A), apart from
// node-process.ts so that file stays under the 600-line limit (plan 0018 §2.3).
//
// Each process the instance spawns is handed to the watchdog with its type's limits, and is
// stopped through its own process group: SIGTERM, then SIGKILL. Its exit is then an unexpected
// exit like any other, so the crash-loop breaker counts it and decides whether it comes back.
// The person is told only once that is known: "started it again" when the next process starts,
// and the breaker's own notice (node-stopped) when it does not.

import { DEFAULT_LIMITS } from "../../domain/supervision/resources";
import type { NodeProcessSpec } from "../../ports/node-process";
import type { NodeProcessDeps } from "./node-process-settings";

export class NodeResourceGuard {
  readonly #spec: NodeProcessSpec;
  readonly #deps: NodeProcessDeps;
  /** Why the last process was stopped, until the next one has started. */
  #stoppedFor: string | null = null;
  #cancel: (() => void) | null = null;

  constructor(spec: NodeProcessSpec, deps: NodeProcessDeps) {
    this.#spec = spec;
    this.#deps = deps;
  }

  /** A process of this instance started: watched, and told of if it replaces a stopped one. */
  spawned(pid: number | undefined, current: () => boolean): void {
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
      return;
    }
    this.#cancel = watchdog({
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
        this.#stoppedFor = why;
      },
    });
  }

  /** The process exited or the instance closed: nothing more is sampled or signalled. */
  ended(): void {
    this.#cancel?.();
    this.#cancel = null;
  }
}
