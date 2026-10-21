// The resource watchdog, as the parts that run processes hand them to it (plan 0031 group A).
// The probe reads the platform's process table (adapters/process/resource-probe.ts); the watch
// judges and stops (application/resource-watch.ts).

import type { ResourceLimits, ResourceSample } from "../domain/supervision/resources";
import type { Cancel } from "./clock";

/** One process as the process table shows it now: what it uses, and who it is. */
export interface ProcessReading {
  readonly sample: ResourceSample;
  /**
   * Who the process is (its start time and executable, children.py's identity): a pid read
   * again with another identity is another process, and is never signalled.
   */
  readonly identity: string;
}

/**
 * One read of the process table for every pid asked about at once (one `ps`, one `lsof`). A pid
 * missing from the answer is gone, or on a platform that is not measured.
 */
export type ResourceProbe = (
  pids: readonly number[],
) => Promise<ReadonlyMap<number, ProcessReading>>;

/** One process to watch, and how it is stopped. */
export interface WatchedProcess {
  readonly pid: number;
  readonly limits: ResourceLimits;
  /** Ask it to stop (SIGTERM, or the app's own polite quit). */
  stop(): void;
  /** End it now (SIGKILL); only called while `current` still holds and it is still itself. */
  kill(): void;
  /** False once this process exited or was replaced: the watch then ends. */
  current(): boolean;
  /** It is about to be stopped for these breaches, already in words. Called once, first. */
  stopped(why: string): void;
}

/**
 * Watch one process until it exits, is replaced, or is stopped for a breach. The Cancel ends the
 * watch at once (the process exited, or its owner closed it), with nothing left scheduled.
 */
export type ResourceWatchdog = (target: WatchedProcess) => Cancel;
