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
// * Children are counted by parent, at any depth, as the old helper did: a child that left its
//   process group still counts. Only a host's node processes are left out of the host's count
//   (each leads its own process group, process-tree.ts): they are judged on their own.
// * Identity is the start time from `ps` and the executable: on macOS the first `txt` file
//   `lsof` lists, on Linux /proc/<pid>/exe. Never the command name, which a node can change.
// * A number the platform will not give (no lsof, a process gone between the two calls) is null
//   on its own: the other numbers are still judged.

import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
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

/** pid, ppid, pgid, rss, time, then `lstart`: five words in the C locale. */
const COLUMNS = "pid=,ppid=,pgid=,rss=,time=,lstart=";

interface Row {
  readonly ppid: number;
  readonly pgid: number;
  readonly rssKb: number;
  readonly time: string;
  readonly started: string;
}

function rowsOf(table: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const line of table.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words.length < 10) {
      continue;
    }
    const [pid, ppid, pgid, rss, time] = words as [string, string, string, string, string];
    rows.set(Number(pid), {
      ppid: Number(ppid),
      pgid: Number(pgid),
      rssKb: Number(rss),
      time,
      started: words.slice(5, 10).join(" "),
    });
  }
  return rows;
}

/**
 * Every process below `pid`, by parent, at any depth (the old helper's count): a child that left
 * its process group still counts. A host's node processes are the exception: each leads a
 * process group of its own (process-tree.ts) and is judged on its own, so for a host a direct
 * child that leads its own group is left out, with its whole tree.
 */
function descendantsOf(pid: number, rows: Map<number, Row>, host: boolean): number {
  const parents = new Set([pid]);
  let found = 0;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, row] of rows) {
      if (!parents.has(row.ppid) || parents.has(child)) {
        continue;
      }
      if (host && row.ppid === pid && row.pgid === child) {
        continue; // a node process the host started
      }
      parents.add(child);
      found += 1;
      grew = true;
    }
  }
  return found;
}

/** What one `lsof -F fn` says of each pid: its open files, and its executable (first `txt`). */
interface Listed {
  readonly files: Map<number, number>;
  readonly executables: Map<number, string>;
}

/** `p<pid>`, then for each file `f<descriptor>` and `n<name>`; only numbered ones are files. */
function listedOf(lsof: string): Listed {
  const files = new Map<number, number>();
  const executables = new Map<number, string>();
  let pid = -1;
  let fd = "";
  for (const line of lsof.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      files.set(pid, 0);
    } else if (line.startsWith("f")) {
      fd = line.slice(1);
      if (/^\d+$/.test(fd)) {
        files.set(pid, (files.get(pid) ?? 0) + 1);
      }
    } else if (line.startsWith("n") && fd === "txt" && !executables.has(pid)) {
      executables.set(pid, line.slice(1));
    }
  }
  return { files, executables };
}

/** On Linux, from /proc: each pid's open files and its executable, each left out if unreadable. */
export interface ProcReader {
  fds(pid: number): Promise<number>;
  executable(pid: number): Promise<string>;
}

const proc: ProcReader = {
  fds: async (pid) => (await readdir(`/proc/${String(pid)}/fd`)).length,
  executable: (pid) => readlink(`/proc/${String(pid)}/exe`),
};

export function resourceProbeFor(
  platform: NodeJS.Platform,
  runCommand: CommandRunner = plainRunner,
  procfs: ProcReader = proc,
): ResourceProbe {
  if (platform === "win32") {
    // Not measured on Windows yet: no reading, never a crash.
    return () => Promise.resolve(new Map());
  }
  const listed = async (pids: readonly number[]): Promise<Listed> => {
    if (platform === "linux") {
      const found: Listed = { files: new Map(), executables: new Map() };
      for (const pid of pids) {
        await procfs.fds(pid).then(
          (count) => found.files.set(pid, count),
          () => undefined, // gone, or not ours to read: left unread
        );
        await procfs.executable(pid).then(
          (path) => found.executables.set(pid, path),
          () => undefined,
        );
      }
      return found;
    }
    try {
      const list = pids.map(String).join(",");
      return listedOf(
        await runCommand("/usr/sbin/lsof", ["-n", "-P", "-w", "-p", list, "-F", "fn"]),
      );
    } catch {
      return { files: new Map(), executables: new Map() };
    }
  };
  return async (pids, hosts = new Set()) => {
    const readings = new Map<number, ProcessReading>();
    if (pids.length === 0) {
      return readings;
    }
    const rows = rowsOf(await runCommand("/bin/ps", ["-A", "-o", COLUMNS]));
    const present = pids.flatMap((pid) => {
      const own = rows.get(pid);
      return own === undefined ? [] : [{ pid, own }];
    });
    const { files, executables } =
      present.length === 0
        ? { files: new Map<number, number>(), executables: new Map<number, string>() }
        : await listed(present.map((p) => p.pid));
    for (const { pid, own } of present) {
      readings.set(pid, {
        identity: { started: own.started, executable: executables.get(pid) ?? null },
        sample: {
          memoryMb: own.rssKb / 1024,
          cpuSeconds: cpuSecondsOf(own.time),
          openFiles: files.get(pid) ?? null,
          children: descendantsOf(pid, rows, hosts.has(pid)),
        },
      });
    }
    return readings;
  };
}
