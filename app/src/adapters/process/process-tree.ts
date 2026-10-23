// "No orphan" (plan 0018 §3, kept from `children.py:544-700`): a node process and everything
// it started end together.
//
// POSIX: the node process is started detached, which makes it the leader of a new session
// and process group whose id is its pid, and every process it starts, at any depth, is in that
// group unless it leaves it. A forced end (`kill`) ends the node itself; what it started is
// ended by the sweep after its exit, as the old host ended a child's descendants
// (children.py `_end_descendants`): asked politely first (SIGTERM to the group), killed after
// the stop timeout if still there, and named when one outlives even that. The group outlives
// its leader while any member is alive, so it can still be signalled after the node exited.
//
// Windows: BLOCKED(WI-0025-01). The equivalent is a Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, which needs native code Node does not ship. Until then
// only the node process itself is killed, and a grandchild can outlive it.
//
// After the node exited (the old host's "a dead child is forgotten; nothing is signalled at its
// pid", children.py): its pid is free again, so it is signalled only through `sweep`, which
// first reads whether its group still has a member. While one does, the system gives that number
// to no new process, so the signal reaches only what the node left. With none left, nothing is
// sent; on Windows, where there is only the bare pid, nothing is sent either.

import { plainRunner, type CommandRunner } from "./resource-probe";

/** How a node process is spawned and ended as one tree. */
export interface ProcessTree {
  /** Pass to `spawn` as `detached`. */
  readonly detached: boolean;
  /** End the node process now (SIGKILL); what it started is the sweep's. Safe when it is gone. */
  kill(pid: number): void;
  /** Ask the whole tree to stop (SIGTERM), politely. Safe when it is already gone. */
  stop(pid: number): void;
  /**
   * After the process `pid` exited: end what is left of its tree, politely and then forcibly;
   * the pids still running after the kill. Never signals a group with no member left, whose
   * number may be another program's by now. Rejects when the process table could not be read;
   * nothing more is signalled then.
   */
  sweep(pid: number): Promise<readonly number[]>;
  /** Why this platform cannot end the whole tree, or null when it can. */
  readonly blocked: string | null;
}

/** `process.kill`, injected so both platforms' trees can be exercised on either. */
export type Signaller = (pid: number, signal: NodeJS.Signals) => void;

const WINDOWS_BLOCKED =
  "BLOCKED(WI-0025-01): Windows Job Objects are not built, so a grandchild of a node " +
  "process can outlive it";

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // ESRCH: the tree is already gone, which is what was asked for.
  }
}

/** The members of process group `pgid` now, from one `ps`. */
export async function groupMembers(pgid: number, run: CommandRunner): Promise<number[]> {
  const table = await run("/bin/ps", ["-A", "-o", "pid=,pgid="]);
  return table.split("\n").flatMap((line) => {
    const [pid, group] = line.trim().split(/\s+/).map(Number);
    return group === pgid && pid !== undefined && pid > 0 ? [pid] : [];
  });
}

/** How long a sweep gives a polite stop, and then a kill, and how often it looks meanwhile. */
export interface SweepPace {
  readonly waitMs: number;
  readonly lookEveryMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_SWEEP: SweepPace = {
  // The old host's stop timeout for a child's descendants.
  waitMs: 5_000,
  lookEveryMs: 250,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export function processTreeFor(
  platform: NodeJS.Platform,
  signal: Signaller = (pid, name) => process.kill(pid, name),
  run: CommandRunner = plainRunner,
  pace: SweepPace = DEFAULT_SWEEP,
): ProcessTree {
  if (platform === "win32") {
    return {
      detached: false,
      blocked: WINDOWS_BLOCKED,
      // Only the bare pid exists here, and the process that had it is gone.
      sweep: () => Promise.resolve([]),
      kill: (pid) => {
        quietly(() => {
          signal(pid, "SIGKILL");
        });
      },
      stop: (pid) => {
        quietly(() => {
          signal(pid, "SIGTERM");
        });
      },
    };
  }
  return {
    detached: true,
    blocked: null,
    sweep: async (pid) => {
      // Each signal follows a read that found a member: the number is the group's still.
      const left = async (): Promise<number[]> => {
        const deadline = Date.now() + pace.waitMs;
        let members = await groupMembers(pid, run);
        while (members.length > 0 && Date.now() < deadline) {
          await pace.sleep(pace.lookEveryMs);
          members = await groupMembers(pid, run);
        }
        return members;
      };
      for (const name of ["SIGTERM", "SIGKILL"] as const) {
        if ((await groupMembers(pid, run)).length === 0) {
          return [];
        }
        quietly(() => {
          signal(-pid, name);
        });
        const still = await left();
        if (still.length === 0 || name === "SIGKILL") {
          return still;
        }
      }
      return [];
    },
    kill: (pid) => {
      quietly(() => {
        signal(pid, "SIGKILL");
      });
    },
    stop: (pid) => {
      quietly(() => {
        signal(-pid, "SIGTERM");
      });
    },
  };
}
