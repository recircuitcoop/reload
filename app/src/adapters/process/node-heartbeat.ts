// A node process's heartbeat (spec 2.4.2; 4.1 `ping`, 4.2 `pong`; plan 0031 B), apart from
// node-process.ts so that file stays under the 600-line limit (plan 0018 §2.3).
//
// The judgement is the application's Heartbeat, the one the Anytype MCP child is watched by,
// handed in as a factory: this file turns its pings into `ping` frames, and `pong` frames back
// into answers carrying the node's progress marker. What a stale verdict leads to is the old
// helper's restart policy (helper/restart.py `child_stale`): nothing is signalled at the
// verdict; the process is stopped when its restart backoff has run out, a backoff that grows
// with each stuck restart in a row, and its exit is then answered at once, the wait already
// served. A type that says never to restart it is stopped the same way, and stays stopped.

import { crashRestartDelay, DEFAULT_BACKOFF } from "../../domain/supervision/backoff";
import { staleWindow } from "../../domain/supervision/staleness";
import type { Cancel } from "../../ports/clock";
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

/** One ping still out: what settles it, and its timeout to cancel. */
interface Waiting {
  readonly answer: (marker: number | undefined) => void;
  readonly cancel: Cancel;
}

export class NodeHeartbeat {
  readonly #deps: NodeProcessDeps;
  readonly #target: HeartbeatTarget;
  readonly #logger: Logger;
  readonly #watch: HeartbeatWatch;
  readonly #subject: string;
  readonly #restartable: boolean;
  readonly #window: number;
  /** The pings sent and not yet answered. */
  readonly #waiting = new Map<string, Waiting>();
  /** The node's own last health answer (spec 4.2 `pong`); null before it gave one. */
  #healthy: boolean | null = null;
  /** Stuck restarts in a row: the restart backoff's n. */
  #stuckInARow = 0;
  /** The person was told about this stuck episode; withdrawn once a process answers again. */
  #stuckSaid = false;
  /** The stop at the end of the restart backoff, while it waits. */
  #restart: Cancel | null = null;
  /** The process now exiting was stopped for being stuck. */
  #stuckExit = false;
  #startedAt = 0;

  constructor(spec: NodeProcessSpec, deps: NodeProcessDeps, target: HeartbeatTarget) {
    if (spec.stability === undefined || deps.heartbeat === undefined) {
      throw new RangeError("a heartbeat needs the type's declared interval and a factory");
    }
    this.#deps = deps;
    this.#target = target;
    this.#subject = spec.identity.name || spec.identity.typeId;
    this.#restartable = spec.restartable !== false;
    this.#window = staleWindow(spec.stability) ?? 0;
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
    this.#startedAt = this.#deps.clock.now();
    this.#watch.start({ ping: (timeoutMs) => this.#ping(timeoutMs) });
  }

  /** The process is gone, or closing: no more pings, none still out counts, nothing waits. */
  stopped(): void {
    this.#watch.stop();
    for (const waiting of this.#waiting.values()) {
      waiting.cancel();
    }
    this.#waiting.clear();
    this.#restart?.();
    this.#restart = null;
  }

  /**
   * Whether the process that just exited was stopped for being stuck, told once: its restart
   * backoff is already served, and its notice is worded for it.
   */
  takeStuckExit(): boolean {
    const stuck = this.#stuckExit;
    this.#stuckExit = false;
    return stuck;
  }

  /**
   * A `pong`: the ping it answers is a beat, carrying the node's progress marker when it sends
   * one; one for an id never sent is ignored. Its `healthy` is carried as it is: a turn to false
   * is said once, and a turn back to true withdraws it (the old helper's Observation.health).
   */
  pong(id: string, healthy?: boolean, progress?: number): void {
    const waiting = this.#waiting.get(id);
    if (waiting === undefined) {
      return;
    }
    this.#waiting.delete(id);
    waiting.cancel();
    waiting.answer(progress);
    this.#answered();
    if (healthy !== undefined && healthy !== this.#healthy) {
      this.#health(healthy);
    }
  }

  /** A process answers: a stuck episode is over, and a whole window of answers ends the run. */
  #answered(): void {
    if (this.#stuckSaid) {
      this.#stuckSaid = false;
      this.#logger.info("answers again after being stuck");
      this.#deps.notifier.clear("node-stuck", this.#subject);
    }
    if (this.#deps.clock.now() - this.#startedAt >= this.#window) {
      this.#stuckInARow = 0;
    }
  }

  #health(healthy: boolean): void {
    const firstAnswer = this.#healthy === null;
    this.#healthy = healthy;
    if (healthy) {
      if (!firstAnswer) {
        this.#logger.info("its health check says it is working again");
      }
      this.#deps.notifier.clear("node-unhealthy", this.#subject);
      return;
    }
    this.#logger.warn("its health check says it is not working");
    this.#raise("node-unhealthy", "Its own health check says it is not working");
  }

  #ping(timeoutMs: number): Promise<number | undefined> {
    const id = this.#deps.newId();
    return new Promise((resolve, reject) => {
      const cancel = this.#deps.clock.after(timeoutMs, () => {
        this.#waiting.delete(id);
        reject(new Error(`no pong within ${String(timeoutMs)} ms`));
      });
      this.#waiting.set(id, { answer: resolve, cancel });
      if (!this.#target.write({ t: "ping", id })) {
        this.#waiting.delete(id);
        cancel();
        reject(new Error("no process is running"));
      }
    });
  }

  /** Stuck: nothing is signalled now; the process is stopped when the backoff has run out. */
  #stale(silentForMs: number): void {
    this.#stuckInARow += 1;
    const delay = crashRestartDelay(this.#stuckInARow, DEFAULT_BACKOFF);
    const seconds = String(Math.round(silentForMs / 1000));
    const then = this.#restartable ? "restarting it" : "stopping it for good";
    this.#logger.error(`stuck: no progress for ${seconds} s; ${then} in ${String(delay)} ms`);
    // A type never restarted is told about once, by the stop itself (node-notices.ts).
    if (this.#restartable && !this.#stuckSaid) {
      this.#stuckSaid = true;
      this.#raise("node-stuck", "Its process made no progress, so Reload restarts it");
    }
    this.#restart = this.#deps.clock.after(delay, () => {
      this.#restart = null;
      const pid = this.#target.pid();
      if (pid !== null) {
        this.#stuckExit = true;
        this.#deps.tree.kill(pid);
      }
    });
  }

  #raise(kind: "node-stuck" | "node-unhealthy", detail: string): void {
    try {
      this.#deps.notifier.raise({ kind, subject: this.#subject, detail });
    } catch (error) {
      this.#logger.error(`a notice could not be raised: ${String(error)}`);
    }
  }
}
