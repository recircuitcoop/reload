// What the watched processes are using, read from what the platform already offers (plan 0031
// group A; the old helper read the same numbers through psutil, helper/processes.py).
//
// One read answers for every pid asked about, so a tick costs the same however many processes
// are watched (the old helper's one lookup for every managed process): one `ps -A` for memory,
// CPU time, descendants and identity, and on macOS one `lsof -p a,b,c` for open files; on Linux
// /proc/<pid>/fd. Windows: not measured, so the answer is empty, never a crash.
//
// * `ps` runs with LC_ALL=C and TZ=UTC: its start time is then the same text on every machine,
//   which is what the identity check compares (a locale's month names broke it elsewhere).
// * Children are counted within the process's own process group. Every node process is started
//   as the leader of its own group (process-tree.ts), so a node process and its tree are judged
//   on their own and never count against the runtime that started them.
// * A number the platform will not give (no lsof, a process gone between the two calls) is null
//   on its own: the other numbers are still judged.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import type { ProcessReading, ResourceProbe } from "../../ports/resource-watch";

/** Runs a command and answers its stdout; rejects when it cannot run or fails. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

/** A fixed locale and zone, and no other environment: `ps` and `lsof` need neither. */
const PLAIN = { LC_ALL: "C", TZ: "UTC" };

/** The runner the probe uses: a fixed locale, a short timeout, and lsof's partial answers. */
export const plainRunner: CommandRunner = async (file, args) => {
  try {
    return (await execFileAsync(file, args, { encoding: "utf8", timeout: 5_000, env: PLAIN }))
      .stdout;
  } catch (error) {
    // lsof exits 1 when one of the pids has gone, and still lists the others.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout !== "") {
      return stdout;
    }
    throw error;
  }
};

const countFds = async (pid: number): Promise<number> =>
  (await readdir(`/proc/${String(pid)}/fd`)).length;

/** `ps` CPU time, `[[dd-]hh:]mm:ss[.cc]` (Linux and macOS spell it differently), in seconds. */
function cpuSecondsOf(time: string): number | null {
  const [clock = "", days = "0"] = time.split("-").reverse();
  if (!/^[\d:.]+$/.test(clock) || !/^\d+$/.test(days)) {
    return null;
  }
  const parts = clock.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
}

/** pid, ppid, pgid, rss, time, then `lstart` (five words in the C locale), then the command. */
const COLUMNS = "pid=,ppid=,pgid=,rss=,time=,lstart=,comm=";

interface Row {
  readonly ppid: number;
  readonly pgid: number;
  readonly rssKb: number;
  readonly time: string;
  readonly identity: string;
}

function rowsOf(table: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const line of table.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words.length < 11) {
      continue;
    }
    const [pid, ppid, pgid, rss, time] = words as [string, string, string, string, string];
    rows.set(Number(pid), {
      ppid: Number(ppid),
      pgid: Number(pgid),
      rssKb: Number(rss),
      time,
      identity: words.slice(5).join(" "),
    });
  }
  return rows;
}

/** Every process below `pid` in its own process group, at any depth. */
function descendantsOf(pid: number, rows: Map<number, Row>): number {
  const group = rows.get(pid)?.pgid;
  const parents = new Set([pid]);
  let found = 0;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, row] of rows) {
      if (row.pgid === group && parents.has(row.ppid) && !parents.has(child)) {
        parents.add(child);
        found += 1;
        grew = true;
      }
    }
  }
  return found;
}

/** `lsof -F f` writes `p<pid>`, then one `f<descriptor>` line per file; only numbers are files. */
function openFilesOf(lsof: string): Map<number, number> {
  const counts = new Map<number, number>();
  let pid = -1;
  for (const line of lsof.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      counts.set(pid, 0);
    } else if (/^f\d+$/.test(line)) {
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
  }
  return counts;
}

export function resourceProbeFor(
  platform: NodeJS.Platform,
  runCommand: CommandRunner = plainRunner,
  fds: (pid: number) => Promise<number> = countFds,
): ResourceProbe {
  if (platform === "win32") {
    // Not measured on Windows yet: no reading, never a crash.
    return () => Promise.resolve(new Map());
  }
  const openFiles = async (pids: readonly number[]): Promise<Map<number, number>> => {
    if (platform === "linux") {
      const counts = new Map<number, number>();
      for (const pid of pids) {
        try {
          counts.set(pid, await fds(pid));
        } catch {
          // gone, or not ours to read: left unread
        }
      }
      return counts;
    }
    try {
      const list = pids.map(String).join(",");
      return openFilesOf(
        await runCommand("/usr/sbin/lsof", ["-n", "-P", "-w", "-p", list, "-F", "f"]),
      );
    } catch {
      return new Map();
    }
  };
  return async (pids) => {
    const readings = new Map<number, ProcessReading>();
    if (pids.length === 0) {
      return readings;
    }
    const rows = rowsOf(await runCommand("/bin/ps", ["-A", "-o", COLUMNS]));
    const present = pids.flatMap((pid) => {
      const own = rows.get(pid);
      return own === undefined ? [] : [{ pid, own }];
    });
    const files =
      present.length === 0 ? new Map<number, number>() : await openFiles(present.map((p) => p.pid));
    for (const { pid, own } of present) {
      readings.set(pid, {
        identity: own.identity,
        sample: {
          memoryMb: own.rssKb / 1024,
          cpuSeconds: cpuSecondsOf(own.time),
          openFiles: files.get(pid) ?? null,
          children: descendantsOf(pid, rows),
        },
      });
    }
    return readings;
  };
}
