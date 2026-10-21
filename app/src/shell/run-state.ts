// The run-state file, and `reload --quit --force` (plan 0031 group E; the old app's run-state file
// and `quit --force`, cli.py:1254, launcher.py:1135, processes.py:493).
//
// The running shell records every process it is answerable for (itself, the runtime, the
// services process, and an Anytype it started; never one it adopted) in its user-data folder,
// mode 0600, each with its identity: its start time and command line as the process table gives
// them. `--quit --force` asks nobody: it reads the file and stops each process itself, politely
// first and forcibly after, and says so out loud when one survived the kill.
//
// A record whose pid now belongs to another program fails the identity check and is forgotten,
// never signalled (processes.py:500). The shell is stopped first, unlike the old helper (last):
// the shell is the supervisor here, and a child stopped before it would only be restarted.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";

export const RUN_STATE_FILENAME = "run-state.json";

/** One process the shell is answerable for. */
export interface RunRecord {
  readonly id: string;
  readonly pid: number;
  /** Start time and command line, as the process table gave them when recorded. */
  readonly identity: string;
}

/** How long a polite stop is given: the shell's own quit stops its children first. */
export const POLITE_MS: Readonly<Record<string, number>> = { shell: 15_000 };
export const DEFAULT_POLITE_MS = 5_000;
/** How long a killed process is given to be gone. */
export const KILLED_MS = 5_000;

/** The process table's line for one pid: its start time and command line. */
export function identityCommand(pid: number, platform: NodeJS.Platform): [string, string[]] {
  if (platform === "win32") {
    return [
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" | ` +
          "ForEach-Object { \"$($_.CreationDate.ToString('o')) $($_.CommandLine)\" }",
      ],
    ];
  }
  return ["/bin/ps", ["-o", "lstart=,args=", "-p", String(pid)]];
}

/** The identity of `pid` now, or null when nothing has that pid. */
export function identityOf(pid: number, platform: NodeJS.Platform): string | null {
  const [command, args] = identityCommand(pid, platform);
  try {
    const line = execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).trim();
    return line === "" ? null : line;
  } catch {
    // ps exits 1 when no process has the pid.
    return null;
  }
}

function identityOfLater(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  const [command, args] = identityCommand(pid, platform);
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      const line = error === null ? stdout.trim() : "";
      resolve(line === "" ? null : line);
    });
  });
}

/** Writes the run-state: each process with the identity it has now, whole, mode 0600. */
export async function writeRunState(
  file: string,
  processes: readonly { readonly id: string; readonly pid: number }[],
  platform: NodeJS.Platform,
): Promise<void> {
  const records: RunRecord[] = [];
  for (const { id, pid } of processes) {
    const identity = await identityOfLater(pid, platform);
    if (identity !== null) {
      records.push({ id, pid, identity });
    }
  }
  const scratch = `${file}.tmp`;
  fs.writeFileSync(scratch, JSON.stringify(records), { mode: 0o600 });
  fs.renameSync(scratch, file);
}

export interface ForceDeps {
  readonly file: string;
  /** The identity of a pid now; null when nothing has it. */
  readonly identity: (pid: number) => string | null;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly now: () => number;
  /** Blocks. */
  readonly sleep: (ms: number) => void;
  readonly print: (text: string) => void;
}

type Outcome = "terminated" | "killed" | "forgotten" | "already stopped" | "still running";

/** `reload --quit --force`: stops every recorded process itself; the exit code. */
export function forceQuit(deps: ForceDeps): number {
  let records: RunRecord[];
  try {
    records = JSON.parse(fs.readFileSync(deps.file, "utf8")) as RunRecord[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      deps.print("Reload is not running.\n");
    } else {
      deps.print(`The run-state file could not be read: ${String(error)}\n`);
    }
    return 1;
  }
  const lines: string[] = [];
  const survivors: RunRecord[] = [];
  const ordered = [...records].sort((a, b) => Number(b.id === "shell") - Number(a.id === "shell"));
  for (const record of ordered) {
    const outcome = stop(record, deps);
    if (outcome === "still running") {
      survivors.push(record);
      continue;
    }
    lines.push(`  ${record.id} ${outcome} (process ${String(record.pid)})`);
  }
  if (survivors.length > 0) {
    // The one case where the command did not do what it promised: said, with each process.
    for (const record of survivors) {
      lines.push(
        `${record.id} (process ${String(record.pid)}) is STILL RUNNING after a forced kill.`,
      );
    }
  } else {
    fs.rmSync(deps.file, { force: true });
    lines.push("Reload is off.");
  }
  deps.print(lines.join("\n") + "\n");
  return 0;
}

/** One process: identity first, then politely, then forcibly (processes.py:493). */
function stop(record: RunRecord, deps: ForceDeps): Outcome {
  const now = deps.identity(record.pid);
  if (now === null) {
    return "already stopped";
  }
  if (now !== record.identity) {
    return "forgotten";
  }
  const gone = (ms: number): boolean => {
    const deadline = deps.now() + ms;
    for (;;) {
      if (deps.identity(record.pid) !== record.identity) {
        return true;
      }
      if (deps.now() >= deadline) {
        return false;
      }
      deps.sleep(100);
    }
  };
  deps.signal(record.pid, "SIGTERM");
  if (gone(POLITE_MS[record.id] ?? DEFAULT_POLITE_MS)) {
    return "terminated";
  }
  deps.signal(record.pid, "SIGKILL");
  return gone(KILLED_MS) ? "killed" : "still running";
}
