// Reload from a terminal (plan 0031 group E; the old app's `helper status`, `quit` and
// `logs`, cli.py:692, 1254, 1540): `reload --status`, `reload --quit` and `reload --log` ask the
// instance already running, print its answer, and exit. With none running they say so and exit 1.
// `reload --quit --force` asks nobody (shell/run-state.ts).
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
import { forceQuit, identityOf, RUN_STATE_FILENAME } from "./run-state";

export type Command = "status" | "quit" | "log";

const FLAGS: Readonly<Record<string, Command>> = {
  "--status": "status",
  "--quit": "quit",
  "--log": "log",
};

/** How long the asking process waits: a quit may first put undeployed edits to the person. */
export const WAIT_MS: Readonly<Record<Command, number>> = {
  status: 10_000,
  log: 10_000,
  quit: 120_000,
};

/** How many of the log's last lines `--log` shows. */
export const LOG_TAIL_LINES = 50;

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
  readonly command: Command;
  readonly id: string;
}

export function isQuestion(value: unknown): value is Question {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { command, id } = value as Record<string, unknown>;
  return (
    (command === "status" || command === "quit" || command === "log") &&
    typeof id === "string" &&
    /^[0-9a-f]{32}$/.test(id)
  );
}

/** The answer: what to print, and the asking process's exit code. */
export interface Reply {
  readonly code: number;
  readonly text: string;
}

export const replyFile = (dir: string, id: string): string => path.join(dir, `command-${id}.reply`);

// ── the asking process ──────────────────────────────────────────────────────────────────────

export interface AskDeps {
  readonly app: Pick<App, "requestSingleInstanceLock" | "getPath">;
  readonly print: (text: string) => void;
  /** 32 hex digits, new for this question. */
  readonly id: string;
  readonly now: () => number;
  /** Blocks: the asking process does nothing else, and must not run the rest of main.ts. */
  readonly sleep: (ms: number) => void;
}

/** Asks the running instance and prints its answer; the exit code. */
export function ask(command: Command, deps: AskDeps): number {
  const { app, print, id } = deps;
  if (app.requestSingleInstanceLock({ command, id } satisfies Question)) {
    // The lock was free: nothing is running to ask. Exiting gives the lock back.
    print("Reload is not running.\n");
    return 1;
  }
  const file = replyFile(app.getPath("userData"), id);
  const deadline = deps.now() + WAIT_MS[command];
  for (;;) {
    const reply = takeReply(file);
    if (reply !== null) {
      print(reply.text);
      return reply.code;
    }
    if (deps.now() >= deadline) {
      print(`Reload did not answer within ${String(WAIT_MS[command] / 1000)} seconds.\n`);
      return 1;
    }
    deps.sleep(50);
  }
}

/** The answer once it is there, read and removed; null while it is not. */
function takeReply(file: string): Reply | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  fs.rmSync(file, { force: true });
  const reply = JSON.parse(text) as Reply;
  return { code: reply.code, text: reply.text };
}

/**
 * main.ts's first act. With a command on the command line, asks, prints and exits the process
 * here, so nothing else in main.ts runs (no log, no first start, no window); otherwise returns.
 */
export function runCommandLine(app: AskDeps["app"], argv: readonly string[]): void {
  const command = commandOf(argv);
  if (command === null) {
    return;
  }
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const print = (text: string) => fs.writeSync(1, text);
  const sleep = (ms: number) => Atomics.wait(waiter, 0, 0, ms);
  if (command === "quit" && argv.includes("--force")) {
    // Asks nobody: what is hung cannot answer (cli.py quit --force).
    process.exit(
      forceQuit({
        file: path.join(app.getPath("userData"), RUN_STATE_FILENAME),
        identity: (pid) => identityOf(pid, process.platform),
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
  });
  process.exit(code);
}

// ── the running instance ────────────────────────────────────────────────────────────────────

/** What the running instance answers from. */
export interface Running {
  readonly supervisors: ReadonlyMap<ChildName, Pick<Supervisor, "status" | "onStatus">>;
  readonly anytype: Pick<AnytypeApp, "state" | "startedPid">;
  /** The log this run writes; null when it could not open one. */
  readonly log: { readonly path: string } | null;
  /** The notice file's name in the user-data folder: the conditions true now. */
  readonly notices: string;
}

export interface AnswerDeps {
  readonly running: Running;
  readonly app: Pick<App, "getPath" | "getVersion">;
  /** The Quit menu's own path: undeployed edits are put to the person first. */
  readonly quit: () => Promise<QuitOutcome>;
  readonly pid: number;
  readonly logger: Logger;
}

/** Answers a question from a second launch; false when it carried none (an ordinary launch). */
export function answerQuestion(data: unknown, deps: AnswerDeps): boolean {
  if (!isQuestion(data)) {
    return false;
  }
  const dir = deps.app.getPath("userData");
  deps.logger.info(`answering \`reload --${data.command}\` from a second launch`);
  void replyTo(data, deps).then(
    (reply) => {
      writeReply(replyFile(dir, data.id), reply, deps.logger);
    },
    (error: unknown) => {
      writeReply(replyFile(dir, data.id), { code: 1, text: `${String(error)}\n` }, deps.logger);
    },
  );
  return true;
}

async function replyTo(question: Question, deps: AnswerDeps): Promise<Reply> {
  switch (question.command) {
    case "status":
      return { code: 0, text: statusText(deps) };
    case "log":
      return { code: 0, text: logText(deps.running.log) };
    case "quit": {
      // Taken before the quit: once it is done the children no longer have a process.
      const stopping = childLines(deps.running.supervisors).map(
        (line) => `  ${line.child} stopped${line.pid === null ? "" : ` (process ${line.pid})`}`,
      );
      const outcome = await deps.quit();
      if (outcome === "cancelled") {
        return {
          code: 1,
          text: "The quit was cancelled in Reload's window. Reload is still running.\n",
        };
      }
      if (outcome === "busy") {
        return { code: 0, text: "Reload is already quitting.\n" };
      }
      return { code: 0, text: [...stopping, "Reload is off."].join("\n") + "\n" };
    }
  }
}

/** Written whole or not at all (renamed into place), readable by this user alone. */
function writeReply(file: string, reply: Reply, logger: Logger): void {
  const scratch = `${file}.tmp`;
  try {
    fs.writeFileSync(scratch, JSON.stringify(reply), { mode: 0o600, flag: "wx" });
    fs.renameSync(scratch, file);
  } catch (error) {
    // Said once, here; the asking process says it got no answer.
    fs.rmSync(scratch, { force: true });
    logger.warn(
      `the answer to a command from a second launch could not be written: ${String(error)}`,
    );
  }
}

const childLines = (supervisors: Running["supervisors"]) =>
  [...supervisors.values()]
    .map((supervisor): ChildStatus => supervisor.status())
    .sort((a, b) => a.child.localeCompare(b.child))
    .map((status) => ({ ...status, pid: status.pid === null ? null : String(status.pid) }));

/** Anytype's line in plain words; null before the launch has decided. */
const ANYTYPE_WORDS: Readonly<Record<AnytypeAppState, string>> = {
  started: "started by Reload",
  adopted: "opened by you; Reload leaves it running",
  missing: "not found on this machine",
  failed: "could not be started",
};

/** What runs, and what was refused or needs the person (helper status, cli.py:1540). */
export function statusText(deps: Omit<AnswerDeps, "quit" | "logger">): string {
  const { running, app } = deps;
  const lines = [`Reload ${app.getVersion()} is running (process ${String(deps.pid)}).`];
  for (const status of childLines(running.supervisors)) {
    const where = status.pid === null ? "" : ` (process ${status.pid})`;
    const why = status.error === null ? "" : ` — ${status.error}`;
    lines.push(`  ${status.child}: ${status.state}${where}${why}`);
  }
  const anytype = running.anytype.state;
  lines.push(`  Anytype: ${anytype === null ? "starting" : ANYTYPE_WORDS[anytype]}`);
  const notices = currentNotices(path.join(app.getPath("userData"), running.notices));
  if (typeof notices === "string") {
    lines.push(notices);
  } else if (notices.length === 0) {
    lines.push("Nothing was refused, and nothing is held back.");
  } else {
    // In the words the notification uses, so the two say the same thing (cli.py _echo_notices).
    for (const notice of notices) {
      const message = compose(notice);
      lines.push(`  ${message.title} — ${message.body}`);
    }
  }
  return lines.join("\n") + "\n";
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

/** Where the log is, and its end (logs, cli.py:692). */
export function logText(log: Running["log"]): string {
  if (log === null) {
    return "Reload could not open a log file in this run.\n";
  }
  const lines = [`Log file: ${log.path}`];
  let text: string;
  try {
    text = fs.readFileSync(log.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    lines.push("  nothing written yet.");
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
