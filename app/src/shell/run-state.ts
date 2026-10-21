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
// never signalled (processes.py:500). The file is read as untrusted: a record that is not one (a
// pid that is not a positive integer above all, since it reaches a command line) makes the whole
// file unreadable, said so, and nothing is signalled. The shell is stopped first, unlike the old helper (last):
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
export const POLITE_MS: ReadonlyMap<string, number> = new Map([["shell", 15_000]]);
export const DEFAULT_POLITE_MS = 5_000;
/** How long a killed process is given to be gone. */
export const KILLED_MS = 5_000;

/** A process id: a positive integer, and so only digits on any command line it is put on. */
export const isPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The process table's line for one pid: its start time and command line. */
export function identityCommand(pid: number, platform: NodeJS.Platform): [string, string[]] {
  if (!isPid(pid)) {
    // Never anything but digits into a command line (PowerShell's one, on Windows).
    throw new RangeError(`not a process id: ${String(pid)}`);
  }
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
  writePrivateFile(file, JSON.stringify(records));
}

/**
 * Writes `text` to `file` whole or not at all (renamed into place), as a regular file this user
 * alone can read. The scratch file is always made new (`wx`, which never follows a link), once a
 * scratch file a crash left is removed (rm removes a link itself, never what it points at); the
 * rename replaces whatever was at `file`, a link included, without following it.
 */
export function writePrivateFile(file: string, text: string): void {
  const scratch = `${file}.tmp`;
  fs.rmSync(scratch, { force: true });
  try {
    fs.writeFileSync(scratch, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(scratch, file);
  } catch (error) {
    fs.rmSync(scratch, { force: true });
    throw error;
  }
}

/**
 * The records in the run-state file: null when there is none, and a sentence saying so when it
 * cannot be read or is not a list of records.
 */
export function readRunState(file: string): readonly RunRecord[] | string | null {
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return `The run-state file could not be read: ${String(error)}`;
  }
  if (!Array.isArray(document) || !document.every(isRunRecord)) {
    return "The run-state file could not be read: it is not a list of the processes Reload ran.";
  }
  return document;
}

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, pid, identity } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    // Printed to the terminal: a name, never a control sequence.
    /^[a-z][a-z0-9-]{0,63}$/.test(id) &&
    isPid(pid) &&
    typeof identity === "string" &&
    identity !== ""
  );
}

/** Which of the records still name the process they were made for. */
export const stillRunning = (
  records: readonly RunRecord[],
  identity: (pid: number) => string | null,
): RunRecord[] => records.filter((record) => identity(record.pid) === record.identity);

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
  const records = readRunState(deps.file);
  if (records === null || typeof records === "string") {
    deps.print(`${records ?? "Reload is not running."}\n`);
    return 1;
  }
  const lines: string[] = [];
  const survivors: RunRecord[] = [];
  for (const record of shellFirst(records)) {
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

/**
 * Plain `reload --quit`, once the running instance said it quit: which of the processes running
 * before it are gone, and which are still running (the old quit's "make sure of it",
 * launcher.py:1121). Each is given the time a polite stop is given; nothing is signalled.
 */
export function confirmQuit(running: readonly RunRecord[], deps: Waiting): string[] {
  const lines: string[] = [];
  const survivors: RunRecord[] = [];
  for (const record of shellFirst(running)) {
    if (goneWithin(record, politeMs(record), deps)) {
      lines.push(`  ${record.id} stopped (process ${String(record.pid)})`);
    } else {
      survivors.push(record);
    }
  }
  for (const record of survivors) {
    lines.push(`${record.id} (process ${String(record.pid)}) is still running after the quit.`);
  }
  if (survivors.length === 0) {
    lines.push("Reload is off.");
  }
  return lines;
}

type Waiting = Pick<ForceDeps, "identity" | "now" | "sleep">;

const shellFirst = (records: readonly RunRecord[]): RunRecord[] =>
  [...records].sort((a, b) => Number(b.id === "shell") - Number(a.id === "shell"));

const politeMs = (record: RunRecord): number => POLITE_MS.get(record.id) ?? DEFAULT_POLITE_MS;

/** Whether the process is gone, or its pid is another program's now, within `ms`. */
function goneWithin(record: RunRecord, ms: number, deps: Waiting): boolean {
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
  deps.signal(record.pid, "SIGTERM");
  if (goneWithin(record, politeMs(record), deps)) {
    return "terminated";
  }
  deps.signal(record.pid, "SIGKILL");
  return goneWithin(record, KILLED_MS, deps) ? "killed" : "still running";
}
