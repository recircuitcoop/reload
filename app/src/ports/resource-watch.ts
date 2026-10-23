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
  /**
   * The descendants it counts that left its process group: a stop of the group does not reach
   * them, so they are stopped one by one (the old host's descendant sweep). Known by start time.
   */
  readonly strays: readonly { readonly pid: number; readonly identity: ProcessIdentity }[];
  /** Its descendants still in its process group, which a signal to the group reaches. */
  readonly group?: readonly { readonly pid: number; readonly identity: ProcessIdentity }[];
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
  /**
   * Stopped through Reload's own handle on it (an Anytype Reload started), as the old app did:
   * only that handle is signalled, and no descendant of it is swept by pid.
   */
  readonly handleOnly?: boolean;
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

/** A node process the runtime started, as recorded for after a crash of the runtime. */
export interface NodeRecord {
  readonly pid: number;
  readonly identity: ProcessIdentity;
}

/**
 * Where the runtime keeps its node processes, so the shell can stop those a crashed runtime
 * left behind before it starts the next one (the old helper's run-state records).
 */
export interface NodeRecordStore {
  /** Every record; none when there is no file. A record that is not one is left out. */
  read(): readonly NodeRecord[];
  /** Replace every record, whole or not at all. */
  write(records: readonly NodeRecord[]): void;
}
