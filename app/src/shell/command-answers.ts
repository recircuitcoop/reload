// What the running Reload answers a terminal with (plan 0031 group E; shell/command-line.ts is
// the asking side): it takes each question file from the user-data folder, removes it, and
// writes the answer as a file of this user's own, named by the question's id.
import fs from "node:fs";
import * as path from "node:path";
import type { App } from "electron";
import type { AnytypeApp, AnytypeAppState } from "../application/anytype-app";
import type { QuitOutcome } from "../application/quit";
import type { Supervisor } from "../application/supervisor";
import type { ChildName, ChildStatus } from "../domain/supervision/child-state";
import type { Logger } from "../ports/logger";
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
  readonly supervisors: ReadonlyMap<ChildName, Pick<Supervisor, "status" | "onStatus">>;
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
      logger.warn(`Reload could not write its ${subject}: ${why}`);
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
  /** The answer files, when they cannot be written. */
  readonly replies: Unwritable;
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
  } catch {
    return;
  }
  for (const name of names) {
    const id = QUESTION_NAME.exec(name)?.[1];
    const question = id === undefined ? null : takeQuestion(path.join(dir, name), id, now);
    if (question !== null) {
      removeStaleReplies(dir, now);
      answerQuestion(question, deps);
    }
  }
}

/**
 * One question, read and removed; null when it is not one to answer: not a small regular file
 * (a link is never followed), not of this moment (an asker that gave up, or was killed, long
 * ago must not quit a later Reload), not a question, or taken back by its asker meanwhile.
 */
function takeQuestion(file: string, id: string, now: number): Question | null {
  let text: string;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 || now - stat.mtimeMs > PICKUP_MS * 2) {
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
  lines.push(...noticeLines(path.join(app.getPath("userData"), running.notices)));
  return lines.join("\n") + "\n";
}
