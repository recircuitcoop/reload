// What a node process is using, read from what the platform already offers (plan 0031 group A;
// the old helper read the same four numbers through psutil, helper/processes.py).
//
// macOS and Linux: one `ps -A` gives every process's parent, resident memory and cumulative CPU
// time, so memory, CPU and the number of descendants come from one cheap call. Open files are
// counted from /proc/<pid>/fd on Linux and from `lsof -p` on macOS (a little dearer, once per
// sample). Windows: not measured. The probe answers null, which the watchdog reads as "no
// reading", never as a reading of zero and never as a breach.
//
// A number the platform will not give (no lsof, a process gone between the two calls) is null
// on its own: the other numbers are still judged.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import type { ResourceProbe } from "../../ports/resource-watch";

/** Runs a command and answers its stdout; rejects when it cannot run or fails. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const run: CommandRunner = async (file, args) =>
  (await execFileAsync(file, args, { encoding: "utf8", timeout: 5_000 })).stdout;

const countFds = async (pid: number): Promise<number> =>
  (await readdir(`/proc/${String(pid)}/fd`)).length;

/** `ps` CPU time, `[[dd-]hh:]mm:ss[.cc]` (Linux and macOS spell it differently), in seconds. */
function cpuSecondsOf(time: string): number | null {
  const match = /^(?:(\d+)-)?([\d:.]+)$/.exec(time);
  if (match === null) {
    return null;
  }
  const days = Number(match[1] ?? 0);
  const parts = (match[2] ?? "").split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0) + days * 86_400;
}

interface Row {
  readonly ppid: number;
  readonly rssKb: number;
  readonly time: string;
}

function rowsOf(table: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const line of table.split("\n")) {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/);
    if (pid !== undefined && ppid !== undefined && rss !== undefined && time !== undefined) {
      rows.set(Number(pid), { ppid: Number(ppid), rssKb: Number(rss), time });
    }
  }
  return rows;
}

/** Every process below `pid`, at any depth. */
function descendantsOf(pid: number, rows: Map<number, Row>): number {
  const parents = new Set([pid]);
  let found = 0;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, row] of rows) {
      if (parents.has(row.ppid) && !parents.has(child)) {
        parents.add(child);
        found += 1;
        grew = true;
      }
    }
  }
  return found;
}

/** `lsof -F f` writes one `f<descriptor>` line per open file; only numbered ones are files. */
function openFilesOf(lsof: string): number {
  return lsof.split("\n").filter((line) => /^f\d+$/.test(line)).length;
}

export function resourceProbeFor(
  platform: NodeJS.Platform,
  runCommand: CommandRunner = run,
  fds: (pid: number) => Promise<number> = countFds,
): ResourceProbe {
  if (platform === "win32") {
    // Not measured on Windows yet: no reading, never a crash.
    return () => Promise.resolve(null);
  }
  const openFiles = async (pid: number): Promise<number | null> => {
    try {
      if (platform === "linux") {
        return await fds(pid);
      }
      return openFilesOf(
        await runCommand("lsof", ["-n", "-P", "-w", "-p", String(pid), "-F", "f"]),
      );
    } catch {
      return null;
    }
  };
  return async (pid) => {
    let table: string;
    try {
      table = await runCommand("ps", ["-A", "-o", "pid=,ppid=,rss=,time="]);
    } catch {
      return null;
    }
    const rows = rowsOf(table);
    const own = rows.get(pid);
    if (own === undefined) {
      return null; // gone since it was started: nothing to judge
    }
    return {
      memoryMb: own.rssKb / 1024,
      cpuSeconds: cpuSecondsOf(own.time),
      openFiles: await openFiles(pid),
      children: descendantsOf(pid, rows),
    };
  };
}
