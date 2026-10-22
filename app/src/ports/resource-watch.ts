// The resource watchdog, as the parts that run processes hand them to it (plan 0031 group A).
// The probe reads the platform's process table (adapters/process/resource-probe.ts); the watch
// judges and stops (application/resource-watch.ts).

import type { ResourceLimits, ResourceSample } from "../domain/supervision/resources";
import type { Cancel } from "./clock";

/**
 * Who a process is (children.py's identity): its start time, and its executable where the
 * platform says (null where it would not). A pid read again as someone else is never signalled.
 */
export interface ProcessIdentity {
  readonly started: string;
  readonly executable: string | null;
}

/** One process as the process table shows it now: what it uses, and who it is. */
export interface ProcessReading {
  readonly sample: ResourceSample;
  readonly identity: ProcessIdentity;
}

/**
 * One read of the process table for every pid asked about at once (one `ps`, one `lsof`). A pid
 * missing from the answer is gone, or on a platform that is not measured. `hosts` are the
 * processes that host node processes (the runtime): the node processes they start, and those
 * processes' trees, are each judged on their own and never counted among a host's children.
 */
export type ResourceProbe = (
  pids: readonly number[],
  hosts?: ReadonlySet<number>,
) => Promise<ReadonlyMap<number, ProcessReading>>;

/** One process to watch, and how it is stopped. */
export interface WatchedProcess {
  readonly pid: number;
  readonly limits: ResourceLimits;
  /** It starts node processes (the runtime): their trees are not its children. */
  readonly hostsNodes?: boolean;
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
