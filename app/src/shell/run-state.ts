// The run-state file, and `reload --quit --force` (plan 0031 group E; the old app's run-state file
// and `quit --force`, cli.py:1254, launcher.py:1135, processes.py:493).
//
// The running shell records every process it is answerable for (itself, the runtime, the
// services process, and an Anytype it started; never one it adopted) in its user-data folder,
// mode 0600, each with its identity: its start time and command line as the process table gives
// them, read with one fixed locale and time zone, so a check from a terminal with another reads
// the same line. `--quit --force` asks nobody: it reads the file and stops each process itself,
// politely first and forcibly after, and says so out loud when one survived the kill or could
// not be checked.
//
// A record whose pid now belongs to another program fails the identity check and is forgotten,
// never signalled (processes.py:500). The file is read as untrusted: a record that is not one (a
// pid that is not a positive integer above all, since it reaches a command line) makes the whole
// file unreadable, said so by the field that is wrong, and nothing is signalled. The shell is
// stopped first, unlike the old helper (last): the shell is the supervisor here, and a child
// stopped before it would only be restarted.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";

export const RUN_STATE_FILENAME = "run-state.json";

/** Text for the terminal: no control character (C0, DEL, C1) but the newline and the tab. */
export function plainText(text: string): string {
  let plain = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 0x20 && (code < 0x7f || code > 0x9f))) {
      plain += char;
    }
  }
  return plain;
}

/** One process the shell is answerable for. */
export interface RunRecord {
  readonly id: string;
  readonly pid: number;
  /** Start time and command line, as the process table gave them when recorded. */
  readonly identity: string;
}

/**
 * The identity of a pid now; null when nothing has that pid. Throws UncheckedIdentity when the
 * process table could not be read: that is never taken for "gone".
 */
export type Identity = (pid: number) => string | null;

export class UncheckedIdentity extends Error {}

/** How long a polite stop is given: the shell's own quit stops its children first. */
export const POLITE_MS: ReadonlyMap<string, number> = new Map([["shell", 15_000]]);
export const DEFAULT_POLITE_MS = 5_000;
/** How long a killed process is given to be gone. */
export const KILLED_MS = 5_000;

/** A process id: a positive integer, and so only digits on any command line it is put on. */
export const isPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * `ps` reads the start time in the locale and time zone it is given: the app started from the
 * Dock has no LANG, a terminal has its own. One of each, fixed, at record time and check alike.
 */
const PS_ENV = { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" };

/** The process table's line for one pid: its start time and command line. */
export function identityCommand(
  pid: number,
  platform: NodeJS.Platform,
): [string, string[], NodeJS.ProcessEnv | undefined] {
  if (!isPid(pid)) {
    // Never anything but digits into a command line (PowerShell's one, on Windows).
    throw new RangeError(`not a process id: ${String(pid)}`);
  }
  if (platform === "win32") {
    // The 'o' format is the same in every culture.
    return [
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" | ` +
          "ForEach-Object { \"$($_.CreationDate.ToUniversalTime().ToString('o')) $($_.CommandLine)\" }",
      ],
      undefined,
    ];
  }
  return ["/bin/ps", ["-o", "lstart=,args=", "-p", String(pid)], PS_ENV];
}

/** Whether a process has the pid: kill(pid, 0) fails with ESRCH only when none has it. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, and belongs to somebody else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * The line the process table gave for `pid`; null when no process has the pid; else throws
 * UncheckedIdentity. "Gone" is never read from `ps`'s exit code, which is 1 for an error too
 * (macOS): only from no line, and the kernel saying no process has the pid.
 */
export function identityFrom(
  pid: number,
  error: Error | null,
  stdout: string,
  exists: (pid: number) => boolean = pidExists,
): string | null {
  const line = stdout.trim();
  if (error === null && line !== "") {
    return line;
  }
  if (line === "" && !exists(pid)) {
    return null;
  }
  const why = error === null ? "it printed nothing for a process that exists" : String(error);
  throw new UncheckedIdentity(`the process table could not be read: ${why}`);
}

/** The identity of `pid` now, or null when nothing has that pid; throws UncheckedIdentity. */
export function identityOf(pid: number, platform: NodeJS.Platform): string | null {
  const [command, args, env] = identityCommand(pid, platform);
  let stdout: string;
  try {
    stdout = execFileSync(command, args, { encoding: "utf8", timeout: 10_000, env });
  } catch (error) {
    const { stdout: printed } = error as { stdout?: unknown };
    return identityFrom(pid, error as Error, typeof printed === "string" ? printed : "");
  }
  return identityFrom(pid, null, stdout);
}

/** identityOf without blocking: for the running instance. */
export function identityOfLater(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  const [command, args, env] = identityCommand(pid, platform);
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 10_000, env }, (error, stdout) => {
      try {
        resolve(identityFrom(pid, error, stdout));
      } catch (unchecked) {
        reject(unchecked instanceof Error ? unchecked : new UncheckedIdentity(String(unchecked)));
      }
    });
  });
}

/**
 * Writes the run-state: each process with the identity it has now, whole, mode 0600. A process
 * table that cannot be read fails the write, so the record before it stays.
 */
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
 * cannot be read or is not a list of records, naming the record and the field that is wrong.
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
  if (!Array.isArray(document)) {
    return "The run-state file could not be read: it is not a list of the processes Reload ran.";
  }
  for (const [index, entry] of document.entries()) {
    const wrong = wrongField(entry);
    if (wrong !== null) {
      return `The run-state file could not be read: record ${String(index + 1)} ${wrong}.`;
    }
  }
  return document as RunRecord[];
}

const FIELDS = new Set(["id", "pid", "identity"]);

/**
 * What is wrong with a record, by field, as the old reader said it (the reader has to know which
 * one to go and fix): a field missing or of the wrong type, or one no record has. Null when it
 * is a record.
 */
function wrongField(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "is not a record";
  }
  const unknown = Object.keys(value).find((name) => !FIELDS.has(name));
  if (unknown !== undefined) {
    // Printed to the terminal: a name, never a control sequence (forceQuit strips them too).
    return /^[A-Za-z_][\w-]{0,63}$/.test(unknown)
      ? `has an unknown field, ${unknown}`
      : "has an unknown field";
  }
  const { id, pid, identity } = value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    return "has no valid id";
  }
  if (!isPid(pid)) {
    return "has no valid pid";
  }
  return typeof identity === "string" && identity !== "" ? null : "has no valid identity";
}

/** Whether a record still names its process: true, false, or why that could not be checked. */
export function stillRuns(record: RunRecord, identity: Identity): boolean | string {
  try {
    return identity(record.pid) === record.identity;
  } catch (error) {
    if (error instanceof UncheckedIdentity) {
      return error.message;
    }
    throw error;
  }
}

export interface ForceDeps {
  readonly file: string;
  readonly identity: Identity;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly now: () => number;
  /** Blocks. */
  readonly sleep: (ms: number) => void;
  readonly print: (text: string) => void;
}

type Outcome = "terminated" | "killed" | "forgotten" | "already stopped" | "still running";

/**
 * `reload --quit --force`: stops every recorded process itself; the exit code. A survivor is
 * said and exits 0, as the old quit did; a process it could not check is said and exits 1.
 * Either way the record is kept, and Reload is not said to be off.
 */
export function forceQuit(deps: ForceDeps): number {
  const print = (text: string) => {
    deps.print(plainText(text));
  };
  const records = readRunState(deps.file);
  if (records === null || typeof records === "string") {
    print(`${records ?? "Reload is not running."}\n`);
    return 1;
  }
  const lines: string[] = [];
  const survivors: string[] = [];
  const unchecked: string[] = [];
  for (const record of shellFirst(records)) {
    const named = `${record.id} (process ${String(record.pid)})`;
    let outcome: Outcome;
    try {
      outcome = stop(record, deps);
    } catch (error) {
      if (!(error instanceof UncheckedIdentity)) throw error;
      unchecked.push(`${named} could not be checked: ${error.message}.`);
      continue;
    }
    if (outcome === "still running") {
      // The one case where the command did not do what it promised: said, with each process.
      survivors.push(`${named} is STILL RUNNING after a forced kill.`);
      continue;
    }
    lines.push(`  ${record.id} ${outcome} (process ${String(record.pid)})`);
  }
  lines.push(...survivors, ...unchecked);
  if (survivors.length === 0 && unchecked.length === 0) {
    fs.rmSync(deps.file, { force: true });
    lines.push("Reload is off.");
  }
  print(lines.join("\n") + "\n");
  return unchecked.length === 0 ? 0 : 1;
}

/**
 * Plain `reload --quit`, once the running instance said it quit: which of the recorded processes
 * are gone, and which are still running or could not be checked (the old quit's "make sure of
 * it", launcher.py:1121). Each is given the time a polite stop is given; nothing is signalled.
 * `off` is whether every one is gone.
 */
export function confirmQuit(
  running: readonly RunRecord[],
  deps: Waiting,
): { readonly lines: string[]; readonly off: boolean } {
  const lines: string[] = [];
  const left: string[] = [];
  for (const record of shellFirst(running)) {
    const named = `${record.id} (process ${String(record.pid)})`;
    try {
      if (goneWithin(record, politeMs(record), deps)) {
        lines.push(`  ${record.id} stopped (process ${String(record.pid)})`);
      } else {
        left.push(`${named} is still running after the quit.`);
      }
    } catch (error) {
      if (!(error instanceof UncheckedIdentity)) throw error;
      left.push(`${named} could not be checked: ${error.message}.`);
    }
  }
  lines.push(...left);
  if (left.length === 0) {
    lines.push("Reload is off.");
  }
  return { lines, off: left.length === 0 };
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
