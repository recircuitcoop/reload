// The resource watchdog, as the parts that run processes hand them to it (plan 0031 group A).
// The probe reads the platform's process table (adapters/process/resource-probe.ts); the watch
// judges and stops (application/resource-watch.ts).

import type { ResourceLimits, ResourceSample } from "../domain/supervision/resources";
import type { Cancel } from "./clock";

/** One sample of `pid`; null when this platform is not measured or the process is gone. */
export type ResourceProbe = (pid: number) => Promise<ResourceSample | null>;

/** One process to watch, and how it is stopped. */
export interface WatchedProcess {
  readonly pid: number;
  readonly limits: ResourceLimits;
  /** Ask it to stop (SIGTERM, or the app's own polite quit). */
  stop(): void;
  /** End it now (SIGKILL); only called while `current` still holds. */
  kill(): void;
  /** False once this process exited or was replaced: the watch then ends. */
  current(): boolean;
  /** It was stopped for these breaches, already in words. Called once. */
  stopped(why: string): void;
}

/**
 * Watch one process until it exits, is replaced, or is stopped for a breach. The Cancel ends the
 * watch at once (the process exited, or its owner closed it), with nothing left scheduled.
 */
export type ResourceWatchdog = (target: WatchedProcess) => Cancel;
