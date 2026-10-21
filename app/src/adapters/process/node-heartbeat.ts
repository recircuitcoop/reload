// A node process's heartbeat (spec 2.4.2; 4.1 `ping`, 4.2 `pong`; plan 0031 B), apart from
// node-process.ts so that file stays under the 600-line limit (plan 0018 §2.3).
//
// The judgement is the application's Heartbeat, the one the Anytype MCP child is watched by,
// handed in as a factory: this file only turns its pings into `ping` frames and `pong` frames
// back into answered pings. A process judged stale is killed; its exit is an unexpected exit
// like any other (spec 6.5), so the instance's own respawn, breaker and `restartable` decide
// whether it comes back.

import type { Logger } from "../../ports/logger";
import type { HeartbeatWatch, NodeProcessSpec } from "../../ports/node-process";
import type { RuntimeFrame } from "./codec";
import type { NodeProcessDeps } from "./node-process-settings";

/** The instance a heartbeat belongs to, as node-process.ts holds it. */
export interface HeartbeatTarget {
  /** How the instance's log lines begin: `[type id]`. */
  readonly who: string;
  /** Write a frame to the current process; false when none is running. */
  readonly write: (frame: RuntimeFrame) => boolean;
  /** The current process's pid; null while none is running. */
  readonly pid: () => number | null;
}

/** The heartbeat of an instance whose type declares one, when the runtime keeps them; else null. */
export function nodeHeartbeat(
  spec: NodeProcessSpec,
  deps: NodeProcessDeps,
  target: HeartbeatTarget,
): NodeHeartbeat | null {
  return spec.stability === undefined || deps.heartbeat === undefined
    ? null
    : new NodeHeartbeat(spec, deps, target);
}

export class NodeHeartbeat {
  readonly #deps: NodeProcessDeps;
  readonly #target: HeartbeatTarget;
  readonly #logger: Logger;
  readonly #watch: HeartbeatWatch;
  readonly #subject: string;
  /** The pings sent and not yet answered: their ids, and what settles each. */
  readonly #waiting = new Map<string, () => void>();

  constructor(spec: NodeProcessSpec, deps: NodeProcessDeps, target: HeartbeatTarget) {
    if (spec.stability === undefined || deps.heartbeat === undefined) {
      throw new RangeError("a heartbeat needs the type's declared interval and a factory");
    }
    this.#deps = deps;
    this.#target = target;
    this.#subject = spec.identity.name || spec.identity.typeId;
    const line = (message: string): string => `${target.who} ${message}`;
    this.#logger = {
      info: (message) => {
        deps.logger.info(line(message));
      },
      warn: (message) => {
        deps.logger.warn(line(message));
      },
      error: (message) => {
        deps.logger.error(line(message));
      },
    };
    this.#watch = deps.heartbeat({
      who: "the node process",
      logger: this.#logger,
      profile: spec.stability,
      onStale: (silentForMs) => {
        this.#stale(silentForMs);
      },
    });
  }

  /** The process sent `ready`: its window starts now, and the first ping goes at once. */
  started(): void {
    this.#watch.start({ ping: (timeoutMs) => this.#ping(timeoutMs) });
  }

  /** The process is gone, or closing: no more pings, and none still waiting counts. */
  stopped(): void {
    this.#watch.stop();
    this.#waiting.clear();
  }

  /** A `pong`: the ping it answers is a beat; one for an id never sent is ignored. */
  pong(id: string): void {
    const answered = this.#waiting.get(id);
    this.#waiting.delete(id);
    answered?.();
  }

  #ping(timeoutMs: number): Promise<void> {
    const id = this.#deps.newId();
    return new Promise((resolve, reject) => {
      const cancel = this.#deps.clock.after(timeoutMs, () => {
        this.#waiting.delete(id);
        reject(new Error(`no pong within ${String(timeoutMs)} ms`));
      });
      this.#waiting.set(id, () => {
        cancel();
        resolve();
      });
      if (!this.#target.write({ t: "ping", id })) {
        this.#waiting.delete(id);
        cancel();
        reject(new Error("no process is running"));
      }
    });
  }

  #stale(silentForMs: number): void {
    const seconds = String(Math.round(silentForMs / 1000));
    this.#logger.error(`stuck: answered no ping for ${seconds} s; killing it`);
    try {
      this.#deps.notifier.raise({
        kind: "node-stuck",
        subject: this.#subject,
        detail: `Its process answered nothing for ${seconds} s, so Reload stopped it`,
      });
    } catch (error) {
      this.#logger.error(`the stuck-process notice could not be raised: ${String(error)}`);
    }
    const pid = this.#target.pid();
    if (pid !== null) {
      this.#deps.tree.kill(pid);
    }
  }
}
