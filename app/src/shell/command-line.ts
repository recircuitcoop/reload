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
// The question travels over Electron's single-instance channel (`additionalData`, which reaches
// the running instance's `second-instance`), never a network port. That channel goes one way, so
// the answer comes back as a file in the user-data folder, mode 0600, named by an id the asking
// process made: the folder and the lock in it are this OS user's own, so only the same user can
// ask or read the answer. The running instance builds the file's path itself from the id; it
// never writes where the question says.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import type { App } from "electron";
import type { AnytypeApp, AnytypeAppState } from "../application/anytype-app";
import type { QuitOutcome } from "../application/quit";
import type { Supervisor } from "../application/supervisor";
import { compose, isNotice, type Notice } from "../domain/notices/notices";
import type { ChildName, ChildStatus } from "../domain/supervision/child-state";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import {
  confirmQuit,
  forceQuit,
  identityOf,
  readRunState,
  RUN_STATE_FILENAME,
  stillRunning,
  writePrivateFile,
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

/** How long the asking process waits: a quit may first put undeployed edits to the person. */
export const WAIT_MS: Readonly<Record<Asked, number>> = {
  status: 10_000,
  quit: 120_000,
};

/** How many of the log's last lines `--log` shows. */
export const LOG_TAIL_LINES = 50;

/** How old an answer nobody took gets before the instance removes it at its next start. */
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
}

const REPLY_ID = /^[0-9a-f]{32}$/;

export function isQuestion(value: unknown): value is Question {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { command, id } = value as Record<string, unknown>;
  return (
    (command === "status" || command === "quit") && typeof id === "string" && REPLY_ID.test(id)
  );
}

/** The answer: what to print, and the asking process's exit code. */
export interface Reply {
  readonly code: number;
  readonly text: string;
}

export const replyFile = (dir: string, id: string): string => path.join(dir, `command-${id}.reply`);

// ── the asking process ──────────────────────────────────────────────────────────────────────

/** The files `--status` reads when Reload cannot answer, and the log `--log` names. */
export interface CommandFiles {
  /** The log, found the way the running app finds it (adapters/fs/log-writer.ts logPath). */
  readonly log: string;
  /** The notice file's name in the user-data folder: the conditions true now. */
  readonly notices: string;
}

export interface AskDeps {
  readonly app: Pick<App, "requestSingleInstanceLock" | "getPath">;
  readonly print: (text: string) => void;
  /** 32 hex digits, new for this question. */
  readonly id: string;
  readonly now: () => number;
  /** Blocks: the asking process does nothing else, and must not run the rest of main.ts. */
  readonly sleep: (ms: number) => void;
  /** The identity of a pid now (shell/run-state.ts identityOf); null when nothing has it. */
  readonly identity: (pid: number) => string | null;
  readonly notices: CommandFiles["notices"];
}

/** Asks the running instance and prints its answer; the exit code. */
export function ask(command: Asked, deps: AskDeps): number {
  const { app, print, id } = deps;
  const dir = app.getPath("userData");
  // Taken before asking: once the quit is done the run-state file is gone.
  const before = command === "quit" ? runningBefore(dir, deps) : null;
  if (app.requestSingleInstanceLock({ command, id } satisfies Question)) {
    // The lock was free: nothing is running to ask. Exiting gives the lock back.
    if (command === "status") {
      print(statusFromFiles(dir, deps));
      return 0;
    }
    print("Reload is not running.\n");
    return 1;
  }
  const reply = awaitReply(replyFile(dir, id), WAIT_MS[command], deps);
  if (reply === null) {
    print(`Reload did not answer within ${String(WAIT_MS[command] / 1000)} seconds.\n`);
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
  print(
    typeof before === "string"
      ? `Reload quit, but what it ran could not be checked: ${before}\n`
      : confirmQuit(before ?? [], deps).join("\n") + "\n",
  );
  return 0;
}

/** The recorded processes running now; a sentence when the record cannot be read. */
function runningBefore(dir: string, deps: AskDeps): readonly RunRecord[] | string {
  const records = readRunState(path.join(dir, RUN_STATE_FILENAME));
  if (records === null) {
    return "it had not recorded its processes yet.";
  }
  return typeof records === "string" ? records : stillRunning(records, deps.identity);
}

/** The answer once it is there; null when none came in time. Either way the file is removed. */
function awaitReply(file: string, ms: number, deps: AskDeps): Reply | null {
  const deadline = deps.now() + ms;
  try {
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
  } finally {
    // An answer that lands after this gave up, or after it was killed, is the instance's to
    // remove at its next start (removeStaleReplies).
    fs.rmSync(file, { force: true });
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
    const running = stillRunning(records ?? [], deps.identity);
    if (running.length === 0) {
      lines.push("Nothing is running.");
    }
    for (const record of running) {
      lines.push(`  ${record.id}: running (process ${String(record.pid)})`);
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
  });
  process.exit(code);
}

// ── the running instance ────────────────────────────────────────────────────────────────────

/** What the running instance answers from. */
export interface Running {
  readonly supervisors: ReadonlyMap<ChildName, Pick<Supervisor, "status" | "onStatus">>;
  readonly anytype: Pick<AnytypeApp, "state" | "startedPid" | "onStarted">;
  readonly notices: CommandFiles["notices"];
}

/**
 * A file a second launch reads that cannot be written: a notice, told once and not once per
 * write, and cleared once a write works again (the old helper's unopened socket,
 * test_control_channel.py). Before the notices exist (the start not done yet) it is a warning
 * in the log, once.
 */
export interface Unwritable {
  readonly failed: (error: unknown) => void;
  readonly worked: () => void;
}

export function unwritable(
  subject: string,
  notifier: () => Notifier | null,
  logger: Logger,
): Unwritable {
  let told = false;
  return {
    failed: (error) => {
      if (told) {
        return;
      }
      told = true;
      const board = notifier();
      if (board === null) {
        logger.warn(`Reload could not write its ${subject}: ${String(error)}`);
        return;
      }
      board.raise({ kind: "command-line-unwritable", subject, detail: String(error) });
    },
    worked: () => {
      if (!told) {
        return;
      }
      told = false;
      notifier()?.clear("command-line-unwritable", subject);
    },
  };
}

export interface AnswerDeps {
  readonly running: Running;
  readonly app: Pick<App, "getPath" | "getVersion">;
  /** The Quit menu's own path: undeployed edits are put to the person first. */
  readonly quit: () => Promise<QuitOutcome>;
  readonly pid: number;
  /** The answer files, when they cannot be written. */
  readonly replies: Unwritable;
  readonly logger: Logger;
}

/** Answers a question from a second launch; false when it carried none (an ordinary launch). */
export function answerQuestion(data: unknown, deps: AnswerDeps): boolean {
  if (!isQuestion(data)) {
    return false;
  }
  const file = replyFile(deps.app.getPath("userData"), data.id);
  deps.logger.info(`answering \`reload --${data.command}\` from a second launch`);
  void replyTo(data, deps).then(
    (reply) => {
      writeReply(file, reply, deps.replies);
    },
    (error: unknown) => {
      writeReply(file, { code: 1, text: `${String(error)}\n` }, deps.replies);
    },
  );
  return true;
}

async function replyTo(question: Question, deps: AnswerDeps): Promise<Reply> {
  switch (question.command) {
    case "status":
      return { code: 0, text: statusText(deps) };
    case "quit": {
      const outcome = await deps.quit();
      if (outcome === "cancelled") {
        return {
          code: 1,
          text: "The quit was cancelled in Reload's window. Reload is still running.\n",
        };
      }
      // What stopped is the asking process's to say: it watches each process go (confirmQuit).
      return { code: 0, text: outcome === "busy" ? "Reload is already quitting.\n" : "" };
    }
  }
}

/** Written whole or not at all, readable by this user alone (shell/run-state.ts). */
function writeReply(file: string, reply: Reply, replies: Unwritable): void {
  try {
    writePrivateFile(file, JSON.stringify(reply));
    replies.worked();
  } catch (error) {
    // The asking process says it got no answer.
    replies.failed(error);
  }
}

/**
 * Removes the answers nobody took: an asking process killed while it waited never removes its
 * own (it blocks, so no handler of its runs). Only `command-<id>.reply` files and their scratch
 * files, by name; a link is removed itself, never followed.
 */
export function removeStaleReplies(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^command-[0-9a-f]{32}\.reply(\.tmp)?$/.test(name)) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      if (now - fs.lstatSync(file).mtimeMs > STALE_REPLY_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Gone meanwhile, or not a file: nothing of ours to remove.
    }
  }
}

const childLines = (supervisors: Running["supervisors"]) =>
  [...supervisors.values()]
    .map((supervisor): ChildStatus => supervisor.status())
    .sort((a, b) => a.child.localeCompare(b.child));

/** Anytype's line in plain words; null before the launch has decided. */
const ANYTYPE_WORDS: Readonly<Record<AnytypeAppState, string>> = {
  started: "started by Reload",
  adopted: "opened by you; Reload leaves it running",
  missing: "not found on this machine",
  failed: "could not be started",
};

/** What runs, and what was refused or needs the person (helper status, cli.py:1540). */
export function statusText(deps: Omit<AnswerDeps, "quit" | "logger" | "replies">): string {
  const { running, app } = deps;
  const lines = [`Reload ${app.getVersion()} is running (process ${String(deps.pid)}).`];
  for (const status of childLines(running.supervisors)) {
    const where = status.pid === null ? "" : ` (process ${String(status.pid)})`;
    const why = status.error === null ? "" : ` — ${status.error}`;
    lines.push(`  ${status.child}: ${status.state}${where}${why}`);
  }
  const anytype = running.anytype.state;
  lines.push(`  Anytype: ${anytype === null ? "starting" : ANYTYPE_WORDS[anytype]}`);
  lines.push(...noticeLines(path.join(app.getPath("userData"), running.notices)));
  return lines.join("\n") + "\n";
}

/** The notice file's conditions, in the words the notification uses (cli.py _echo_notices). */
function noticeLines(file: string): string[] {
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

/** Where the log is, whether or not it exists yet, and its end (logs, cli.py:692). */
export function logText(file: string): string {
  const lines = [`Log file: ${file}`];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      lines.push(`  it could not be read: ${String(error)}`);
      return lines.join("\n") + "\n";
    }
    lines.push("  nothing written yet: no Reload process has logged on this machine.");
    return lines.join("\n") + "\n";
  }
  lines.push(`  ${String(Buffer.byteLength(text))} bytes; the last lines:`);
  lines.push(
    ...text
      .split("\n")
      .filter((line) => line !== "")
      .slice(-LOG_TAIL_LINES),
  );
  return lines.join("\n") + "\n";
}
