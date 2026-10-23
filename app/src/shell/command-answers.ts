// What the running Reload answers a terminal with (plan 0031 group E; shell/command-line.ts is
// the asking side): it takes each question file from the user-data folder, removes it, and
// writes the answer as a file of this user's own, named by the question's id. `--list` and the
// package verbs (`--stop <package>…`) are the runtime's to answer: it holds the node processes.
import fs from "node:fs";
import * as path from "node:path";
import type { App } from "electron";
import type { AnytypeApp, AnytypeAppState } from "../application/anytype-app";
import type { QuitOutcome } from "../application/quit";
import type { Supervisor } from "../application/supervisor";
import type { ChildName, ChildStatus } from "../domain/supervision/child-state";
import type { NodeRow } from "../application/instance-readiness";
import type { Logger } from "../ports/logger";
import type { Notice } from "../domain/notices/notices";
import type { Notifier } from "../ports/notifier";
import {
  isQuestion,
  noticeLines,
  PICKUP_MS,
  QUESTION_POLL_MS,
  replyFile,
  STALE_REPLY_MS,
  type CommandFiles,
  type Question,
  type Reply,
} from "./command-line";
import { writePrivateFile } from "./run-state";

/** What the running instance answers from. */
export interface Running {
  /** The runtime's `call` asks it for its node processes (`reload --list`, `--stop` …). */
  readonly supervisors: ReadonlyMap<
    ChildName,
    Pick<Supervisor, "status" | "onStatus"> & Partial<Pick<Supervisor, "call">>
  >;
  readonly anytype: Pick<AnytypeApp, "state" | "startedPid" | "onStarted">;
  readonly notices: CommandFiles["notices"];
}

/**
 * A file a terminal command reads that cannot be written: a notice, told once and not once per
 * write, and cleared once a write works again (the old helper's unopened socket,
 * test_control_channel.py). Before the notices exist (the start not done yet) it is a warning
 * in the log, once, and the notice follows as soon as they do (`ready`) while it still fails.
 */
export interface Unwritable {
  readonly failed: (error: unknown) => void;
  readonly worked: () => void;
  /** The notices exist now. */
  readonly ready: () => void;
}

export function unwritable(
  subject: string,
  notifier: () => Notifier | null,
  logger: Logger,
): Unwritable {
  let told: "no" | "logged" | "raised" = "no";
  let why = "";
  const raise = (board: Notifier) => {
    told = "raised";
    board.raise({ kind: "command-line-unwritable", subject, detail: why });
  };
  return {
    failed: (error) => {
      if (told !== "no") {
        return;
      }
      why = String(error);
      const board = notifier();
      if (board !== null) {
        raise(board);
        return;
      }
      told = "logged";
      logger.warn(`Reload could not use its ${subject}: ${why}`);
    },
    worked: () => {
      if (told === "raised") {
        notifier()?.clear("command-line-unwritable", subject);
      }
      told = "no";
    },
    ready: () => {
      const board = notifier();
      if (told === "logged" && board !== null) {
        raise(board);
      }
    },
  };
}

export interface AnswerDeps {
  readonly running: Running;
  readonly app: Pick<App, "getPath" | "getVersion">;
  /** The Quit menu's own path: undeployed edits are put to the person first. */
  readonly quit: () => Promise<QuitOutcome>;
  readonly pid: number;
  /** The answer files, when they cannot be written; the questions' folder, when unreadable. */
  readonly replies: Unwritable;
  readonly questions: Unwritable;
  /** Whether the process that asked still runs as itself; rejects when it cannot be checked. */
  readonly askerRuns: (pid: number, identity: string) => Promise<boolean>;
  readonly logger: Logger;
}

/**
 * Looks for questions every QUESTION_POLL_MS and answers each; the function that stops it. Each
 * question also sweeps the answers nobody took.
 */
export function answerQuestions(deps: AnswerDeps): () => void {
  const dir = deps.app.getPath("userData");
  const timer = setInterval(() => {
    takeQuestions(dir, deps, Date.now());
  }, QUESTION_POLL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

const QUESTION_NAME = /^command-([0-9a-f]{32})\.question$/;

/** Answers every question in `dir` now. */
export function takeQuestions(dir: string, deps: AnswerDeps, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // Told once, not on every look (the old helper's unopened socket).
    deps.questions.failed(error);
    return;
  }
  deps.questions.worked();
  for (const name of names) {
    const id = QUESTION_NAME.exec(name)?.[1];
    const question = id === undefined ? null : takeQuestion(path.join(dir, name), id, now);
    if (question === null) {
      continue;
    }
    removeStaleReplies(dir, now);
    // Only while the very process that asked still runs: one interrupted or killed while
    // Reload could not answer must not quit it once it can. Unchecked is not "it runs".
    deps.askerRuns(question.pid, question.identity).then(
      (runs) => {
        if (runs) {
          answerQuestion(question, deps);
        } else {
          deps.logger.info(`left \`reload --${question.command}\` unanswered: its asker is gone`);
        }
      },
      (error: unknown) => {
        // Never a wait on nothing: a status is answered all the same, a quit is refused aloud.
        if (question.command === "status") {
          answerQuestion(question, deps);
          return;
        }
        deps.logger.warn("did not answer `reload --quit`: its asker could not be checked");
        const text =
          "Reload could not check the process that asked it to quit, so it did not quit: " +
          `${String(error)}\n`;
        const file = replyFile(deps.app.getPath("userData"), question.id);
        writeReply(file, { code: 1, text }, deps.replies);
      },
    );
  }
}

/**
 * One question, read and removed; null when it is not one to answer: not a small regular file
 * (a link is never followed), older than PICKUP_MS (its asker has given up on it by then, and
 * must not quit a later Reload), not a question, or taken back by its asker meanwhile.
 */
function takeQuestion(file: string, id: string, now: number): Question | null {
  let text: string;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 8192 || now - stat.mtimeMs > PICKUP_MS) {
        fs.rmSync(file, { force: true });
        return null;
      }
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    // Answered only once it is removed here: an asker that took it back first gets no answer.
    fs.unlinkSync(file);
  } catch {
    fs.rmSync(file, { force: true });
    return null;
  }
  let question: unknown;
  try {
    question = JSON.parse(text);
  } catch {
    return null;
  }
  return isQuestion(question) && question.id === id ? question : null;
}

/** Answers one question from a terminal. */
export function answerQuestion(question: Question, deps: AnswerDeps): void {
  const file = replyFile(deps.app.getPath("userData"), question.id);
  deps.logger.info(`answering \`reload --${question.command}\` from a terminal`);
  void replyTo(question, deps).then(
    (reply) => {
      writeReply(file, reply, deps.replies);
    },
    (error: unknown) => {
      writeReply(file, { code: 1, text: `${String(error)}\n` }, deps.replies);
    },
  );
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
    default:
      return nodesReply(question, deps.running);
  }
}

/**
 * `reload --list`, and a verb for the named packages' instances (the old helper's list, start,
 * stop, kill, restart and release), answered by the runtime. Exit code 0 only when the verb
 * applied to every instance it names.
 */
async function nodesReply(question: Question, running: Running): Promise<Reply> {
  const runtime = running.supervisors.get("runtime");
  const verb = question.command === "list" ? null : question.command;
  const result =
    runtime?.call === undefined
      ? { ok: false as const, error: "the Reload runtime cannot be asked" }
      : verb === null
        ? await runtime.call("nodes.list", null)
        : await runtime.call("nodes.command", { verb, names: question.names });
  if (!result.ok) {
    return { code: 1, text: `Reload could not do it: ${result.error}\n` };
  }
  const { rows, refused } = (
    verb === null ? { rows: result.value, refused: [] } : result.value
  ) as {
    rows: readonly NodeRow[];
    refused: readonly (Pick<NodeRow, "name" | "package"> & { why: string })[];
  };
  const lines = [...rows]
    .sort((a, b) => a.package.localeCompare(b.package) || a.name.localeCompare(b.name))
    .map((row) => {
      const where = row.pid === null ? "" : ` (process ${String(row.pid)})`;
      return `  ${row.package} › ${row.name}: ${row.state}${where}${row.why === null ? "" : ` — ${row.why}`}`;
    });
  if (lines.length === 0) {
    lines.push("No node runs in Reload.");
  }
  for (const each of refused) {
    lines.push(`  ${each.package} › ${each.name}: not done (--${verb ?? ""}): ${each.why}`);
  }
  return { code: refused.length === 0 ? 0 : 1, text: lines.join("\n") + "\n" };
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
 * Removes the answers and questions nobody took: an asking process killed while it waited never
 * removes its own (it blocks, so no handler of its runs). Only `command-<id>.reply` and
 * `.question` files and their scratch files, by name; a link is removed itself, never followed.
 */
export function removeStaleReplies(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^command-[0-9a-f]{32}\.(reply|question)(\.tmp)?$/.test(name)) {
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
  // A child stopped for good is said on its own line above: its notice would say it twice.
  const shown = new Set<string>(childLines(running.supervisors).map((status) => status.child));
  const said = (notice: Notice) => notice.kind === "child-stopped" && shown.has(notice.subject);
  lines.push(...noticeLines(path.join(app.getPath("userData"), running.notices), said));
  return lines.join("\n") + "\n";
}
