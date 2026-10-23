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
  type WatchPace,
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
  deps: Omit<WatchDeps, "pace"> & { readonly store: NodeRecordStore; readonly pace?: WatchPace },
): ResourceWatchdog {
  const { store, pace, ...watch } = deps;
  return recordingWatchdog(resourceWatchdog({ ...watch, pace: pace ?? DEFAULT_WATCH_PACE }), {
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

/** One process of a left node's tree, as first read: the leader, a group member or a stray. */
interface Member {
  readonly pid: number;
  readonly identity: NodeRecord["identity"];
  /** The node process whose tree it is; its own pid for the node process. */
  readonly leader: number;
  /** In the leader's process group, which a signal to the group reaches. */
  readonly inGroup: boolean;
}

/**
 * Stop every recorded node process that is still itself, and what it started, politely and then
 * forcibly; resolves once each is gone or has outlived its kill. Rejects, signalling nothing,
 * when the process table cannot be read.
 */
export async function stopLeftNodes(deps: LeftNodesDeps): Promise<void> {
  const recorded = deps.store.read();
  if (recorded.length === 0) {
    return;
  }
  const readings = await deps.probe(recorded.map((record) => record.pid));
  const leaders = recorded.filter((record) => {
    const now = readings.get(record.pid)?.identity;
    return now !== undefined && sameProcess(now, record.identity);
  });
  if (leaders.length > 0) {
    deps.logger.warn(
      `stopping ${String(leaders.length)} node process(es) the last runtime left running: ` +
        leaders.map((record) => String(record.pid)).join(", "),
    );
  }
  // Each leader with its tree as read now: the group a signal to it reaches, and the strays that
  // left it, which are signalled one by one.
  const members: Member[] = leaders.flatMap((record) => {
    const reading = readings.get(record.pid);
    const leader = record.pid;
    return [
      { ...record, leader, inGroup: true },
      ...(reading?.group ?? []).map((one) => ({ ...one, leader, inGroup: true })),
      ...(reading?.strays ?? []).map((one) => ({ ...one, leader, inGroup: false })),
    ];
  });
  let left = await signalAndWait(members, "SIGTERM", deps);
  if (left.length > 0) {
    left = await signalAndWait(left, "SIGKILL", deps);
  }
  for (const member of left) {
    deps.logger.error(`node process ${String(member.pid)} is still running after a forced kill`);
  }
  // A survivor keeps its record: forgotten, it would be a process nothing here can stop.
  const survivors = new Set(left.map((member) => member.pid));
  deps.store.write(recorded.filter((record) => survivors.has(record.pid)));
}

/** The members still surely themselves. */
async function stillThemselves(members: readonly Member[], deps: LeftNodesDeps): Promise<Member[]> {
  const readings = await deps.probe(members.map((member) => member.pid));
  return members.filter((member) => {
    const now = readings.get(member.pid)?.identity;
    return now !== undefined && sameProcess(now, member.identity);
  });
}

/**
 * Signal each member still itself: a leader through its group, the others by pid. Then wait up to
 * `waitMs` for them to go; the ones still themselves.
 */
async function signalAndWait(
  members: readonly Member[],
  signal: "SIGTERM" | "SIGKILL",
  deps: LeftNodesDeps,
): Promise<Member[]> {
  // Read again just before: a member gone since is never signalled by its pid.
  const now = await stillThemselves(members, deps);
  const leaders = new Set(now.filter((m) => m.pid === m.leader).map((m) => m.pid));
  for (const member of now) {
    const leads = member.pid === member.leader;
    // A member of a group whose leader is still itself is reached by the group's signal; one
    // whose leader went is signalled by its own pid, read again just now.
    if (!leads && member.inGroup && leaders.has(member.leader)) {
      continue;
    }
    try {
      deps.signal(leads ? -member.pid : member.pid, signal);
    } catch {
      // ESRCH: gone already, which is what was asked for.
    }
  }
  const deadline = deps.clock.now() + (deps.waitMs ?? LEFT_NODE_WAIT_MS);
  let left = now;
  while (left.length > 0 && deps.clock.now() < deadline) {
    await new Promise<void>((resolve) => deps.clock.after(LOOK_EVERY_MS, resolve));
    left = await stillThemselves(left, deps);
  }
  return left;
}
