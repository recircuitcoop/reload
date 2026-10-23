// "No orphan" (plan 0018 §3, kept from `children.py:544-700`): a node process and everything
// it started end together.
//
// POSIX: the node process is started detached, which makes it the leader of a new session
// and process group whose id is its pid. Killing the negative pid signals the whole group,
// so a grandchild the node started (a `sleep`, a model server) goes with it, on close and on
// crash. The group outlives its leader while any member is alive, so it can still be killed
// after the node itself has exited.
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
  /** End the whole tree now. Safe when it is already gone. */
  kill(pid: number): void;
  /** Ask the whole tree to stop (SIGTERM), politely. Safe when it is already gone. */
  stop(pid: number): void;
  /**
   * After the process `pid` exited: end what is left of its tree, if anything. Never signals a
   * group with no member left, whose number may be another program's by now. Rejects when the
   * process table could not be read; nothing is signalled then.
   */
  sweep(pid: number): Promise<void>;
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

/** Whether any process is a member of process group `pgid` now, from one `ps`. */
export async function groupHasMembers(pgid: number, run: CommandRunner): Promise<boolean> {
  const table = await run("/bin/ps", ["-A", "-o", "pgid="]);
  return table.split("\n").some((line) => Number(line.trim()) === pgid);
}

export function processTreeFor(
  platform: NodeJS.Platform,
  signal: Signaller = (pid, name) => process.kill(pid, name),
  run: CommandRunner = plainRunner,
): ProcessTree {
  if (platform === "win32") {
    return {
      detached: false,
      blocked: WINDOWS_BLOCKED,
      // Only the bare pid exists here, and the process that had it is gone.
      sweep: () => Promise.resolve(),
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
      if (await groupHasMembers(pid, run)) {
        quietly(() => {
          signal(-pid, "SIGKILL");
        });
      }
    },
    kill: (pid) => {
      quietly(() => {
        signal(-pid, "SIGKILL");
      });
    },
    stop: (pid) => {
      quietly(() => {
        signal(-pid, "SIGTERM");
      });
    },
  };
}
