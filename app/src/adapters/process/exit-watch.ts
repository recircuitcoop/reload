// How a node process's pipes are read and its exit is noticed (spec 3, 6.5), apart from
// node-process.ts so that file stays under the 600-line limit (plan 0018 §2.3).

import type { ChildProcessWithoutNullStreams as ChildProcess } from "node:child_process";

import { forEachLine } from "../../domain/logging/lines";
import { LineReader, type ReadLine } from "./codec";
import type { ProcessTree } from "./process-tree";

/** Hand every stdout line to `stdout` and every stderr line to `stderr`, as they come. */
export function readPipes(
  child: ChildProcess,
  stdout: (lines: ReadLine[]) => void,
  stderr: (text: string) => void,
): void {
  const reader = new LineReader();
  child.stdout.on("data", (chunk: Buffer) => {
    stdout(reader.push(chunk));
  });
  child.stdout.on("end", () => {
    stdout(reader.end());
  });
  child.stderr.setEncoding("utf8");
  forEachLine(child.stderr, (line) => {
    stderr(line.cut ? `${line.text} [line cut]` : line.text);
  });
  child.stdin.on("error", () => {
    // A dead process's stdin; its exit is what reports it.
  });
}

export interface ExitWatch {
  /** After the process exits, how long its pipes may stay open before the exit is handled. */
  readonly graceMs: number;
  /** Schedule on the instance's own timers, which a close or an exit cancels. */
  readonly after: (ms: number, callback: () => void) => void;
  /** Its process group: whatever the process started goes with it. */
  readonly tree: Pick<ProcessTree, "sweep">;
  readonly log: (message: string) => void;
  /**
   * Called once, with how it ended: `code N`, `signal S` or "failed to start"; for a process
   * that never started, also why (the spawn error), so it is not taken for a crash.
   */
  readonly exited: (how: string, failure?: string) => void;
}

/**
 * The pid of a process that has not exited, else null: once it has, its pid may be another
 * program's, and is never signalled.
 */
export function livePid(child: ChildProcess): number | null {
  return child.exitCode === null && child.signalCode === null ? (child.pid ?? null) : null;
}

/** End the tree of a process that has not exited; nothing once it has. */
export function killLive(tree: Pick<ProcessTree, "kill">, child: ChildProcess): void {
  const pid = livePid(child);
  if (pid !== null) {
    tree.kill(pid);
  }
}

/** Handle the exit once its pipes have closed, or after the grace period if they do not. */
export function watchExit(child: ChildProcess, watch: ExitWatch): void {
  let how: string | null = null;
  let failure: string | undefined;
  let handled = false;
  const handle = (): void => {
    if (!handled) {
      handled = true;
      if (how === null) {
        watch.exited("failed to start", failure ?? "it did not start");
      } else {
        watch.exited(how);
      }
    }
  };
  child.on("error", (error) => {
    watch.log(`spawn failed: ${error.message}`);
    if (child.pid === undefined) {
      failure = error.message;
      handle();
    }
  });
  child.on("exit", (code, signal) => {
    how = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
    // The node is gone; whatever it started goes too, on close and on crash alike. Its number
    // may be reused once its group is empty, so the sweep signals only a group with a member.
    if (child.pid !== undefined) {
      watch.tree.sweep(child.pid).then(
        (survivors) => {
          if (survivors.length > 0) {
            watch.log(`still running beneath it after a forced kill: ${survivors.join(", ")}`);
          }
        },
        (error: unknown) => {
          watch.log(
            `what it started could not be checked, so nothing was signalled: ${String(error)}`,
          );
        },
      );
    }
    watch.after(watch.graceMs, handle);
  });
  child.on("close", handle);
}
