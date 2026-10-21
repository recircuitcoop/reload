// The settings and dependencies of a node process (node-process.ts), apart so that file
// stays under the 600-line limit (plan 0018 §2.3).

import * as fs from "node:fs";

import { DEFAULT_QUEUE, type QueueSettings } from "../../domain/journal/queue";
import { DEFAULT_CRASH_LOOP, type CrashLoopSettings } from "../../domain/supervision/breaker";
import type { Clock } from "../../ports/clock";
import type { JournalStore } from "../../ports/journal-store";
import type { Logger, SecretSink } from "../../ports/logger";
import type { HeartbeatFactory, HeldInputs, NodeProcessSpec } from "../../ports/node-process";
import type { Notifier } from "../../ports/notifier";
import type { ChildSignal } from "../../domain/telemetry/reports";
import type { ResourceWatchdog } from "../../ports/resource-watch";
import type { NodeCrashSink } from "../../ports/telemetry";
import type { ProcessTree } from "./process-tree";

/** Every number a node process is run by (spec 4.4, 6.3, 6.5). */
export interface NodeProcessSettings {
  /** `start` → `ready`, or the process is killed and counted as an unexpected exit. */
  readonly readyDeadlineMs: number;
  /** `close` → exit, or SIGKILL. */
  readonly closeDeadlineMs: number;
  /** An unexpected exit → the next process. */
  readonly respawnDelayMs: number;
  readonly crashLoop: CrashLoopSettings;
  /**
   * After the process exits, how long its pipes may stay open before the exit is handled
   * anyway. Normally they close at once, and waiting for that is what lets a `done` written
   * just before the exit be read before its input is failed.
   */
  readonly exitGraceMs: number;
  /** The bound on outstanding inputs and what happens at it (spec 7.6). */
  readonly queue: QueueSettings;
}

export const DEFAULT_NODE_PROCESS: NodeProcessSettings = {
  readyDeadlineMs: 30_000,
  closeDeadlineMs: 5_000,
  respawnDelayMs: 1_000,
  crashLoop: DEFAULT_CRASH_LOOP,
  exitGraceMs: 500,
  queue: DEFAULT_QUEUE,
};

export interface NodeProcessDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notifier: Notifier;
  readonly tree: ProcessTree;
  /** A fresh envelope id (a UUID in the app). */
  readonly newId: () => string;
  /** The log redactor: every credential is registered before the process can print a line. */
  readonly secrets: SecretSink;
  /** The runtime's one journal; this instance writes its own entries to it. */
  readonly journal: JournalStore;
  readonly settings: NodeProcessSettings;
  /** Told of every unexpected exit, for the crash reports (WI-0018-22); absent in most tests. */
  readonly crashes?: NodeCrashSink;
  /** The resource watchdog every process is handed to (plan 0031); absent: not watched. */
  readonly watchdog?: ResourceWatchdog;
  /** Told which runs have inputs held at the queue bound (plan 0022 §C); absent in most tests. */
  readonly held?: HeldInputs;
  /** Builds the heartbeat of a type that declares one (spec 2.4.2); without it, none is kept. */
  readonly heartbeat?: HeartbeatFactory;
  /** Told of every step that ended, for the usage signals (plan 0029); absent in most tests. */
  readonly steps?: (signal: ChildSignal) => void;
}

/**
 * Before an instance's first spawn: the process tree's warning, every secret registered so no
 * line of the node is written unredacted (spec 11.1), and its data directory.
 */
export function prepareInstance(spec: NodeProcessSpec, deps: NodeProcessDeps, who: string): void {
  if (deps.tree.blocked !== null) {
    deps.logger.warn(`${who} ${deps.tree.blocked}`);
  }
  for (const secret of Object.values(spec.credentials)) {
    if (secret !== "") {
      deps.secrets.protect(secret);
    }
  }
  fs.mkdirSync(spec.dataDir, { recursive: true });
}
