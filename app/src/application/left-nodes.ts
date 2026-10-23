// Node processes a crashed runtime left behind (the old helper's orphans, processes.py
// `clear_before`): each is stopped, politely and then forcibly, before the next runtime starts.
//
// The runtime records every node process it starts, with its identity as the process table
// gives it (pid, start time, executable), and forgets it once its watch ends. A node is stopped
// with the runtime in an orderly close; after a crash nothing closes it, and a node that ignores
// its closed stdin would run on beside the next runtime's. So before every start of the runtime
// the shell reads the records, and for each that is still the process recorded: SIGTERM to its
// process group (process-tree.ts: it leads one), then, after the polite wait, SIGKILL to those
// still themselves. A record whose pid is someone else now is forgotten, never signalled. One
// that survives the kill keeps its record, said in the log; the start goes ahead either way.
//
// Windows is not measured (resource-probe.ts), so nothing is recorded there.

import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type {
  NodeRecord,
  NodeRecordStore,
  ResourceProbe,
  ResourceWatchdog,
} from "../ports/resource-watch";
import {
  DEFAULT_WATCH_PACE,
  resourceWatchdog,
  sameProcess,
  type WatchDeps,
} from "./resource-watch";

type Log = WatchDeps["log"];

/**
 * The runtime's watchdog, recording each process it is handed while its watch lasts. A process
 * the probe cannot read (gone already, or Windows) is not recorded.
 */
export function recordingWatchdog(
  inner: ResourceWatchdog,
  deps: { readonly probe: ResourceProbe; readonly store: NodeRecordStore; readonly log: Log },
): ResourceWatchdog {
  // What the shell could not stop before this runtime started stays recorded until it is gone.
  const records = new Map<number, NodeRecord>(
    deps.store.read().map((record) => [record.pid, record]),
  );
  const save = (): void => {
    try {
      deps.store.write([...records.values()]);
    } catch (error) {
      deps.log("error", `the node processes could not be recorded: ${String(error)}`);
    }
  };
  return (target) => {
    let watching = true;
    void deps.probe([target.pid]).then(
      (readings) => {
        const reading = readings.get(target.pid);
        if (watching && reading !== undefined && target.current()) {
          records.set(target.pid, { pid: target.pid, identity: reading.identity });
          save();
        }
      },
      (error: unknown) => {
        deps.log("warn", `node process ${String(target.pid)} not recorded: ${String(error)}`);
      },
    );
    const cancel = inner(target);
    return () => {
      watching = false;
      cancel();
      if (records.delete(target.pid)) {
        save();
      }
    };
  };
}

/** The runtime's watchdog of its node processes, each recorded while it is watched. */
export function runtimeWatchdog(
  deps: Omit<WatchDeps, "pace"> & { readonly store: NodeRecordStore },
): ResourceWatchdog {
  const { store, ...watch } = deps;
  return recordingWatchdog(resourceWatchdog({ ...watch, pace: DEFAULT_WATCH_PACE }), {
    probe: deps.probe,
    store,
    log: deps.log,
  });
}

export interface LeftNodesDeps {
  readonly store: NodeRecordStore;
  readonly probe: ResourceProbe;
  /** `process.kill`; a negative pid is a process group. */
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly clock: Clock;
  readonly logger: Logger;
  /** How long the polite stop, and then the kill, are each given; absent, LEFT_NODE_WAIT_MS. */
  readonly waitMs?: number;
}

/** The old helper's polite wait for an orphan, and as long again for its kill. */
export const LEFT_NODE_WAIT_MS = 5_000;

/** How often a stopped process is looked at again while it is waited for. */
const LOOK_EVERY_MS = 100;

/**
 * Stop every recorded node process that is still itself, politely and then forcibly; resolves
 * once each is gone or has outlived its kill. Rejects, signalling nothing, when the process
 * table cannot be read.
 */
export async function stopLeftNodes(deps: LeftNodesDeps): Promise<void> {
  const recorded = deps.store.read();
  if (recorded.length === 0) {
    return;
  }
  let left = await stillThemselves(recorded, deps);
  if (left.length > 0) {
    deps.logger.warn(
      `stopping ${String(left.length)} node process(es) the last runtime left running: ` +
        left.map((record) => String(record.pid)).join(", "),
    );
    left = await signalAndWait(left, "SIGTERM", deps);
  }
  if (left.length > 0) {
    left = await signalAndWait(left, "SIGKILL", deps);
  }
  for (const record of left) {
    deps.logger.error(`node process ${String(record.pid)} is still running after a forced kill`);
  }
  // A survivor keeps its record: forgotten, it would be a process nothing here can stop.
  deps.store.write(left);
}

/** The records whose pid is still the process recorded. */
async function stillThemselves(
  records: readonly NodeRecord[],
  deps: LeftNodesDeps,
): Promise<NodeRecord[]> {
  const readings = await deps.probe(records.map((record) => record.pid));
  return records.filter((record) => {
    const now = readings.get(record.pid)?.identity;
    return now !== undefined && sameProcess(now, record.identity);
  });
}

/** Signal each group, then wait up to `waitMs` for them to go; the ones still themselves. */
async function signalAndWait(
  records: readonly NodeRecord[],
  signal: "SIGTERM" | "SIGKILL",
  deps: LeftNodesDeps,
): Promise<NodeRecord[]> {
  for (const record of records) {
    try {
      deps.signal(-record.pid, signal);
    } catch {
      // ESRCH: gone already, which is what was asked for.
    }
  }
  const deadline = deps.clock.now() + (deps.waitMs ?? LEFT_NODE_WAIT_MS);
  let left = [...records];
  while (left.length > 0 && deps.clock.now() < deadline) {
    await new Promise<void>((resolve) => deps.clock.after(LOOK_EVERY_MS, resolve));
    left = await stillThemselves(left, deps);
  }
  return left;
}
