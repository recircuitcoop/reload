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

import { spawn } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";

import type { ProcessReading, ResourceProbe } from "../../ports/resource-watch";

/**
 * Runs a command and answers its whole stdout; rejects when it cannot run, fails or is cut off.
 * `exitOne` accepts exit code 1 with a complete answer (lsof's, when one of its pids has gone).
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  exitOne?: boolean,
) => Promise<string>;

/** A fixed locale and zone, and no other environment: `ps` and `lsof` need neither. */
const PLAIN = { LC_ALL: "C", TZ: "UTC" };

/**
 * The probe's runner. A command that runs past `timeoutMs` is killed and the read rejected at
 * once, whether or not the child ever goes (a `ps` stuck in an uninterruptible wait would never
 * close its pipes): half an answer is never read, and the watch's next tick still comes.
 */
export function commandRunner(timeoutMs: number): CommandRunner {
  return (file, args, exitOne = false) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { env: PLAIN, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (done: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          done();
        }
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => {
          reject(new Error(`${file} did not answer within ${String(timeoutMs)} ms`));
        });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", (error) => {
        settle(() => {
          reject(error);
        });
      });
      child.on("close", (code, signal) => {
        const stdout = Buffer.concat(chunks).toString("utf8");
        settle(() => {
          if (code === 0 || (exitOne && code === 1 && stdout !== "")) {
            resolve(stdout);
          } else {
            reject(new Error(`${file} ended with ${signal ?? `code ${String(code)}`}`));
          }
        });
      });
    });
}

export const plainRunner: CommandRunner = commandRunner(5_000);

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
function descendantsOf(pid: number, rows: Map<number, Row>, host: boolean): number[] {
  const parents = new Set([pid]);
  const found: number[] = [];
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
      found.push(child);
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
  /** Told once, the first time lsof cannot run: open files and identities then go unread. */
  warn: (message: string) => void = () => undefined,
): ResourceProbe {
  let warned = false;
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
        await runCommand("/usr/sbin/lsof", ["-n", "-P", "-w", "-p", list, "-F", "fn"], true),
      );
    } catch (error) {
      if (!warned) {
        warned = true;
        warn(
          `lsof could not run (${String(error)}): open files are not judged, and a process is ` +
            "known by its start time alone, until it can",
        );
      }
      return { files: new Map(), executables: new Map() };
    }
  };
  return async (pids, hosts = new Set()) => {
    const readings = new Map<number, ProcessReading>();
    if (pids.length === 0) {
      return readings;
    }
    const rows = rowsOf(await runCommand("/bin/ps", ["-A", "-o", COLUMNS]));
    // A pid of zero or less names a process group, never one process: never measured, as the
    // old helper's process table refused it (helper/processes.py default_signaller).
    const present = pids.flatMap((pid) => {
      if (pid < 1) {
        return [];
      }
      const own = rows.get(pid);
      return own === undefined ? [] : [{ pid, own }];
    });
    const { files, executables } =
      present.length === 0
        ? { files: new Map<number, number>(), executables: new Map<number, string>() }
        : await listed(present.map((p) => p.pid));
    for (const { pid, own } of present) {
      const descendants = descendantsOf(pid, rows, hosts.has(pid));
      readings.set(pid, {
        identity: { started: own.started, executable: executables.get(pid) ?? null },
        sample: {
          memoryMb: own.rssKb / 1024,
          cpuSeconds: cpuSecondsOf(own.time),
          openFiles: files.get(pid) ?? null,
          children: descendants.length,
        },
        strays: descendants.flatMap((child) => {
          const row = rows.get(child);
          return row === undefined || row.pgid === own.pgid
            ? []
            : [{ pid: child, identity: { started: row.started, executable: null } }];
        }),
      });
    }
    return readings;
  };
}
