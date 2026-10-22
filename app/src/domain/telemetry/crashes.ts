// What a crash report is and what it may carry (plan 0018 §3 telemetry.py: Port; plan 0003 F2):
// which process crashed and how often each has, never what it was working on. Apart from
// reports.ts, which holds the usage signals; reports.ts re-exports it.

import { versionFields, type Versions } from "./vocabulary";

/** The processes whose crashes are counted: the two supervised children and a node's process. */
export type CrashedProcess = "runtime" | "services" | "node";

/** How often each has crashed since the app started. */
export interface CrashCounts {
  readonly runtime: number;
  readonly services: number;
  readonly node: number;
  /** Node instances the crash-loop limit stopped. */
  readonly nodeStopped: number;
}

/** The exception type a crash is grouped under on the error server. */
export const CRASH_TYPES: Readonly<Record<CrashedProcess, string>> = {
  runtime: "RuntimeCrashed",
  services: "ServicesCrashed",
  node: "NodeProcessCrashed",
};

/**
 * One crash report's body, before redaction: which process crashed, whether the crash-loop limit
 * stopped it, and the counts. Never what the process was working on: no node's name, no input, no
 * message, no log line (plan 0003: an error report never carries the exception's message).
 */
export function crashPayload(
  crashed: CrashedProcess,
  stoppedForGood: boolean,
  counts: CrashCounts,
  versions: Versions,
): Record<string, unknown> {
  return {
    ...versionFields(versions),
    exception_type: CRASH_TYPES[crashed],
    crashed,
    stopped_for_good: stoppedForGood,
    crashes: {
      runtime: counts.runtime,
      services: counts.services,
      node: counts.node,
      node_stopped: counts.nodeStopped,
    },
  };
}
