// Reload from a terminal (plan 0031 group E; the old app's `helper status`, `quit` and
// `logs`, cli.py:692, 1254, 1540): `reload --status` and `reload --quit` ask the instance already
// running, print its answer, and exit. `reload --log` asks nobody: it names the log the way the
// running app finds it, and shows its end. `reload --quit --force` asks nobody either
// (shell/run-state.ts).
//
// `--status` answers from the files when nothing runs or the instance does not answer in time,
// as the old status always did (cli.py:1586): a status that needs Reload to answer says nothing
// at the moment a person most wants to know, when Reload is what is wedged. Plain `--quit` makes
// sure of the quit (launcher.py:1121): it names what stopped and what still runs after it.
//
// The asking process never takes the single-instance lock: Electron kills a lock holder that
// does not acknowledge a second launch, so asking would kill the very Reload that is stuck. It
// learns whether Reload runs from the run-state file and the process table, and asks with a
// question file in the user-data folder (0600, made new, named by an id it made), which the
// running instance takes and removes (answerQuestions). The answer comes back as a file named by
// the same id, which the instance builds itself; it never writes where a question says. The
// folder is this OS user's own, so only the same user can ask or read an answer; there is no
// port. A question nobody takes within PICKUP_MS is taken back. A question carries its asker's
// pid and identity, and the instance acts on one only while that very process still runs and
// within PICKUP_MS of its writing: an asker interrupted or killed while it waited (it blocks,
// so it can run no handler to take its question back) leaves nothing a Reload that wakes later
// acts on.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import type { App } from "electron";
import { compose, isNotice, type Notice } from "../domain/notices/notices";
import {
  confirmQuit,
  forceQuit,
  identityOf,
  isPid,
  plainText,
  readRunState,
  RUN_STATE_FILENAME,
  stillRuns,
  writePrivateFile,
  type Identity,
  type RunRecord,
} from "./run-state";

export type Command = "status" | "quit" | "log";

/** The commands put to the running instance; `--log` is answered by the asking process. */
export type Asked = Exclude<Command, "log">;

const FLAGS: Readonly<Record<string, Command>> = {
  "--status": "status",
  "--quit": "quit",
  "--log": "log",
};

/** How long a running instance has to take a question; one that does not is not answering. */
export const PICKUP_MS = 5_000;

/** How often the running instance looks for questions. */
export const QUESTION_POLL_MS = 200;

/** How long the asking process waits for the answer to a question taken: a quit may first put
 * undeployed edits to the person. */
export const WAIT_MS: Readonly<Record<Asked, number>> = {
  status: 10_000,
  quit: 120_000,
};

/** How many of the log's last lines `--log` shows. */
export const LOG_TAIL_LINES = 50;

/** How old an answer nobody took gets before the instance removes it, at each question. */
export const STALE_REPLY_MS = 5 * 60_000;

/** The command on this command line, or null for an ordinary launch. */
export function commandOf(argv: readonly string[]): Command | null {
  for (const arg of argv) {
    const command = FLAGS[arg];
    if (command !== undefined) {
      return command;
    }
  }
  return null;
}

/** What the asking process sends: the command, and the id its answer file is named by. */
export interface Question {
  readonly command: Asked;
  readonly id: string;
  /** The asking process, and its identity (shell/run-state.ts identityOf) when it asked. */
  readonly pid: number;
  readonly identity: string;
}

const REPLY_ID = /^[0-9a-f]{32}$/;

export function isQuestion(value: unknown): value is Question {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { command, id, pid, identity } = value as Record<string, unknown>;
  return (
    (command === "status" || command === "quit") &&
    typeof id === "string" &&
    REPLY_ID.test(id) &&
    isPid(pid) &&
    typeof identity === "string" &&
    identity !== "" &&
    identity.length <= 4096
  );
}

/** The answer: what to print, and the asking process's exit code. */
export interface Reply {
  readonly code: number;
  readonly text: string;
}

export const replyFile = (dir: string, id: string): string => path.join(dir, `command-${id}.reply`);

export const questionFile = (dir: string, id: string): string =>
  path.join(dir, `command-${id}.question`);

// ── the asking process ──────────────────────────────────────────────────────────────────────

/** The files `--status` reads when Reload cannot answer, and the log `--log` names. */
export interface CommandFiles {
  /** The log, found the way the running app finds it (adapters/fs/log-writer.ts logPath). */
  readonly log: string;
  /** The notice file's name in the user-data folder: the conditions true now. */
  readonly notices: string;
}

export interface AskDeps {
  readonly app: Pick<App, "getPath">;
  readonly print: (text: string) => void;
  /** 32 hex digits, new for this question. */
  readonly id: string;
  readonly now: () => number;
  /** Blocks: the asking process does nothing else, and must not run the rest of main.ts. */
  readonly sleep: (ms: number) => void;
  /** The identity of a pid now (shell/run-state.ts identityOf). */
  readonly identity: Identity;
  readonly notices: CommandFiles["notices"];
  /** This process, which the question names, and the executable Reload runs as. */
  readonly pid: number;
  readonly executable: string;
}

/** Asks the running instance and prints its answer; the exit code. */
export function ask(command: Asked, deps: AskDeps): number {
  const print = (text: string) => {
    deps.print(plainText(text));
  };
  const dir = deps.app.getPath("userData");
  const runState = path.join(dir, RUN_STATE_FILENAME);
  const records = readRunState(runState);
  if (!mayRun(records, deps.identity)) {
    if (starting(dir, deps)) {
      // Holding the lock before its first record lands: running, not yet answerable.
      print("Reload is starting and cannot answer yet. Try again in a moment.\n");
      return command === "status" ? 0 : 1;
    }
    if (command === "status") {
      print(statusFromFiles(dir, deps));
      return 0;
    }
    print("Reload is not running.\n");
    return 1;
  }
  // Taken before asking: once the quit is done the run-state file is gone.
  const before = command === "quit" ? recordedRunning(records, deps.identity) : [];
  const { reply, unanswered } = askInstance(command, dir, deps);
  if (reply === null) {
    print(unanswered);
    if (command === "status") {
      print(statusFromFiles(dir, deps));
      return 0;
    }
    return 1;
  }
  print(reply.text);
  if (command !== "quit" || reply.code !== 0) {
    return reply.code;
  }
  // Read again: a child restarted with a new pid while Reload quit is checked too.
  const after = readRunState(runState);
  if (typeof records === "string" && typeof after === "string") {
    print(`Reload quit, but what it ran could not be checked: ${after}\n`);
    return 0;
  }
  const watched = [...before];
  for (const record of recordedRunning(after, deps.identity)) {
    if (!watched.some((seen) => seen.id === record.id && seen.pid === record.pid)) {
      watched.push(record);
    }
  }
  const { lines, off } = confirmQuit(watched, deps);
  if (off) {
    // Everything it recorded is gone: so is the record, even of a shell that ended unclean.
    fs.rmSync(runState, { force: true });
  }
  print(lines.join("\n") + "\n");
  return 0;
}

/** Whether Reload may be running: its shell's record names a live process, or cannot tell. */
function mayRun(records: ReturnType<typeof readRunState>, identity: Identity): boolean {
  if (typeof records === "string") {
    return true;
  }
  const shell = records?.find((record) => record.id === "shell");
  return shell !== undefined && stillRuns(shell, identity) !== false;
}

/**
 * Whether a Reload holds the single-instance lock: Chromium's lock is a link in the user-data
 * folder to `<host>-<pid>` (POSIX), read here, never taken; its pid must still run this
 * executable. shortcut: POSIX only; Windows' lock is a mutex, with plan 0025.
 */
function starting(dir: string, deps: Pick<AskDeps, "identity" | "executable">): boolean {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(dir, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (!isPid(pid)) {
    return false;
  }
  try {
    return deps.identity(pid)?.includes(deps.executable) ?? false;
  } catch {
    // The process table could not say: a lock held, possibly; not "not running".
    return true;
  }
}

/** The recorded processes that still run, or could not be checked. */
const recordedRunning = (records: ReturnType<typeof readRunState>, identity: Identity) =>
  Array.isArray(records)
    ? (records as readonly RunRecord[]).filter((record) => stillRuns(record, identity) !== false)
    : [];

/**
 * Puts the question to the running instance and waits for its answer: PICKUP_MS for the
 * instance to take the question, then the command's own wait. Whatever happens, the question
 * and the answer file are this process's to remove.
 */
function askInstance(
  command: Asked,
  dir: string,
  deps: AskDeps,
): { readonly reply: Reply | null; readonly unanswered: string } {
  const question = questionFile(dir, deps.id);
  const answer = replyFile(dir, deps.id);
  const unanswered = (ms: number) => `Reload did not answer within ${String(ms / 1000)} seconds.\n`;
  try {
    try {
      const identity = deps.identity(deps.pid);
      if (identity === null) throw new Error("this process is not in the process table");
      const asked: Question = { command, id: deps.id, pid: deps.pid, identity };
      writePrivateFile(question, JSON.stringify(asked));
    } catch (error) {
      return { reply: null, unanswered: `Reload could not be asked: ${String(error)}\n` };
    }
    const pickup = deps.now() + PICKUP_MS;
    while (fs.existsSync(question)) {
      if (deps.now() >= pickup && withdraw(question)) {
        return { reply: null, unanswered: unanswered(PICKUP_MS) };
      }
      deps.sleep(50);
    }
    const reply = awaitReply(answer, WAIT_MS[command], deps);
    return { reply, unanswered: unanswered(WAIT_MS[command]) };
  } finally {
    // An answer that lands after this gave up, or after it was killed, is the instance's to
    // remove (removeStaleReplies).
    fs.rmSync(question, { force: true });
    fs.rmSync(answer, { force: true });
  }
}

/** Takes the question back; false when the instance took it this very moment. */
function withdraw(question: string): boolean {
  try {
    fs.unlinkSync(question);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** The answer once it is there; null when none came in time. */
function awaitReply(file: string, ms: number, deps: AskDeps): Reply | null {
  const deadline = deps.now() + ms;
  for (;;) {
    const reply = takeReply(file);
    if (reply !== null) {
      return reply;
    }
    if (deps.now() >= deadline) {
      return null;
    }
    deps.sleep(50);
  }
}

/** The answer once it is there, read; null while it is not. */
function takeReply(file: string): Reply | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    reply = null;
  }
  const { code, text: said } = (reply ?? {}) as Partial<Record<string, unknown>>;
  if (!Number.isInteger(code) || typeof said !== "string") {
    return { code: 1, text: "Reload's answer could not be read.\n" };
  }
  return { code: code as number, text: said };
}

/**
 * `--status` from the files alone (helper status, cli.py:1560): what the run-state file records
 * that still runs, and the notice file's conditions.
 */
export function statusFromFiles(dir: string, deps: Pick<AskDeps, "identity" | "notices">): string {
  const lines: string[] = [];
  const records = readRunState(path.join(dir, RUN_STATE_FILENAME));
  if (typeof records === "string") {
    lines.push(records);
  } else {
    let running = 0;
    for (const record of records ?? []) {
      const runs = stillRuns(record, deps.identity);
      const where = `(process ${String(record.pid)})`;
      if (runs === true) {
        lines.push(`  ${record.id}: running ${where}`);
      } else if (runs !== false) {
        lines.push(`  ${record.id}: could not be checked ${where}: ${runs}`);
      }
      running += runs === false ? 0 : 1;
    }
    if (running === 0) {
      lines.push("Nothing is running.");
    }
  }
  lines.push(...noticeLines(path.join(dir, deps.notices)));
  return lines.join("\n") + "\n";
}

/**
 * main.ts's first act. With a command on the command line, answers it, prints and exits the
 * process here, so nothing else in main.ts runs (no log, no first start, no window); otherwise
 * returns.
 */
export function runCommandLine(
  app: AskDeps["app"],
  argv: readonly string[],
  files: CommandFiles,
): void {
  const command = commandOf(argv);
  if (command === null) {
    return;
  }
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const print = (text: string) => fs.writeSync(1, text);
  const sleep = (ms: number) => Atomics.wait(waiter, 0, 0, ms);
  const identity = (pid: number) => identityOf(pid, process.platform);
  if (command === "log") {
    // Asks nobody, so it answers with nothing running too (logs, cli.py:692).
    print(logText(files.log));
    process.exit(0);
  }
  if (command === "quit" && argv.includes("--force")) {
    // Asks nobody: what is hung cannot answer (cli.py quit --force).
    process.exit(
      forceQuit({
        file: path.join(app.getPath("userData"), RUN_STATE_FILENAME),
        identity,
        signal: (pid, signal) => {
          try {
            process.kill(pid, signal);
          } catch {
            // Gone between the identity check and the signal: the wait that follows sees it.
          }
        },
        now: Date.now,
        sleep,
        print,
      }),
    );
  }
  const code = ask(command, {
    app,
    print,
    id: randomBytes(16).toString("hex"),
    now: Date.now,
    sleep,
    identity,
    notices: files.notices,
    pid: process.pid,
    executable: process.execPath,
  });
  process.exit(code);
}

/** The notice file's conditions, in the words the notification uses (cli.py _echo_notices). */
export function noticeLines(file: string): string[] {
  const notices = currentNotices(file);
  if (typeof notices === "string") {
    return [notices];
  }
  if (notices.length === 0) {
    return ["Nothing was refused, and nothing is held back."];
  }
  return notices.map((notice) => {
    const message = compose(notice);
    return `  ${message.title} — ${message.body}`;
  });
}

/**
 * The conditions true now, from the notice file the NoticeBoard rewrites on every change, so
 * each is listed once however often it was raised. A run's notices are news of the moment, not
 * a condition, and are left out. A file that cannot be read is said, not taken for "nothing".
 */
function currentNotices(file: string): readonly Notice[] | string {
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return `What needs your attention could not be read: ${String(error)}`;
  }
  if (!Array.isArray(document)) {
    return "What needs your attention could not be read: the notice file is not a list.";
  }
  return document
    .map((entry: unknown) => (isNotice(entry) ? withoutBlanks(entry) : null))
    .filter((notice): notice is Notice => notice !== null && !notice.kind.startsWith("run-"));
}

/** The file writes an absent version or detail as "" (adapters/fs/notice-file.ts). */
const withoutBlanks = (notice: Notice): Notice => ({
  kind: notice.kind,
  subject: notice.subject,
  ...(notice.version === undefined || notice.version === "" ? {} : { version: notice.version }),
  ...(notice.detail === undefined || notice.detail === "" ? {} : { detail: notice.detail }),
});

/**
 * Where the log is, whether or not it exists yet, and its end (logs, cli.py:692), as plain text:
 * a line the log took from elsewhere never drives the terminal.
 */
export function logText(file: string): string {
  return plainText(logLines(file).join("\n") + "\n");
}

function logLines(file: string): string[] {
  const lines = [`Log file: ${file}`];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      lines.push(`  it could not be read: ${String(error)}`);
      return lines;
    }
    lines.push("  nothing written yet: no Reload process has logged on this machine.");
    return lines;
  }
  lines.push(`  ${String(Buffer.byteLength(text))} bytes; the last lines:`);
  lines.push(
    ...text
      .split("\n")
      .filter((line) => line !== "")
      .slice(-LOG_TAIL_LINES),
  );
  return lines;
}
