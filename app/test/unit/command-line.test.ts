// Reload from a terminal (plan 0031 group E): `reload --status`, `--quit` and `--log` ask the
// running instance over the single-instance channel and print its answer, read back from a file
// of this user's own in the user-data folder.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonNoticeFile, NOTICES_FILENAME } from "../../src/adapters/fs/notice-file";
import { NoticeBoard } from "../../src/application/notices";
import type { QuitOutcome } from "../../src/application/quit";
import { compose, type Notice } from "../../src/domain/notices/notices";
import type { ChildName, ChildStatus } from "../../src/domain/supervision/child-state";
import {
  answerQuestion,
  ask,
  commandOf,
  LOG_TAIL_LINES,
  replyFile,
  WAIT_MS,
  type AnswerDeps,
  type Reply,
  type Running,
} from "../../src/shell/command-line";
import { runShell } from "../../src/shell/lifecycle";
import { RecordingLogger } from "../fakes/children";

const ID = "0123456789abcdef0123456789abcdef";

let userData: string;
beforeEach(() => {
  userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-command-line-")));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const child = (name: ChildName, pid: number | null, state: ChildStatus["state"] = "running") => ({
  onStatus: () => undefined,
  status: (): ChildStatus => ({
    child: name,
    state,
    generation: 1,
    pid,
    port: null,
    error: state === "down-for-good" ? "It stopped 5 times in 2 minutes." : null,
  }),
});

function running(overrides: Partial<Running> = {}): Running {
  return {
    supervisors: new Map([
      ["services", child("services", 4243)],
      ["runtime", child("runtime", 4242)],
    ]),
    anytype: { state: "adopted", startedPid: null },
    log: null,
    notices: NOTICES_FILENAME,
    ...overrides,
  };
}

function deps(overrides: Partial<AnswerDeps> = {}) {
  const logger = new RecordingLogger();
  const quits: QuitOutcome[] = [];
  const answer: AnswerDeps = {
    running: running(),
    app: { getPath: () => userData, getVersion: () => "1.2.3" },
    quit: () => {
      quits.push("quit");
      return Promise.resolve("quit");
    },
    pid: 4000,
    logger,
    ...overrides,
  };
  return { answer, logger, quits };
}

/** The reply the running instance wrote for the question, once it is there. */
async function replyFor(id = ID): Promise<Reply> {
  const file = replyFile(userData, id);
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Reply;
}

describe("the command line", () => {
  it("names the command, and none for an ordinary launch", () => {
    expect(commandOf(["/Applications/Reload.app/Contents/MacOS/Reload", "--status"])).toBe(
      "status",
    );
    expect(commandOf(["electron", "app", "--quit"])).toBe("quit");
    expect(commandOf(["electron", "app", "--log"])).toBe("log");
    expect(commandOf(["electron", "app"])).toBeNull();
    expect(commandOf(["electron", "app", "--inspect"])).toBeNull();
  });
});

describe("the asking process", () => {
  function asking(lockFree: boolean, onAsk?: (data: unknown) => void) {
    const printed: string[] = [];
    let clock = 0;
    const sent: unknown[] = [];
    const code = (command: "status" | "quit" | "log") =>
      ask(command, {
        app: {
          requestSingleInstanceLock: (data?: Record<string, unknown>) => {
            sent.push(data);
            onAsk?.(data);
            return lockFree;
          },
          getPath: () => userData,
        },
        print: (text) => printed.push(text),
        id: ID,
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
        },
      });
    return { code, printed, sent };
  }

  it("says plainly that Reload is not running, and exits 1", () => {
    const { code, printed } = asking(true);
    expect(code("status")).toBe(1);
    expect(printed).toEqual(["Reload is not running.\n"]);
  });

  it("sends the command and its id, prints the answer, and removes the answer file", () => {
    const { code, printed, sent } = asking(false, () => {
      fs.writeFileSync(
        replyFile(userData, ID),
        JSON.stringify({ code: 0, text: "Reload is off.\n" }),
      );
    });
    expect(code("quit")).toBe(0);
    expect(sent).toEqual([{ command: "quit", id: ID }]);
    expect(printed).toEqual(["Reload is off.\n"]);
    expect(fs.readdirSync(userData)).toEqual([]);
  });

  it("says so when no answer comes in time, and exits 1", () => {
    const { code, printed } = asking(false);
    expect(code("status")).toBe(1);
    expect(printed).toEqual([
      `Reload did not answer within ${String(WAIT_MS.status / 1000)} seconds.\n`,
    ]);
  });
});

describe("the running instance answers", () => {
  it("leaves an ordinary launch, and a question it cannot trust, to bring the window forward", () => {
    const { answer } = deps();
    expect(answerQuestion(undefined, answer)).toBe(false);
    expect(answerQuestion({ command: "status", id: "../../elsewhere" }, answer)).toBe(false);
    expect(answerQuestion({ command: "rm", id: ID }, answer)).toBe(false);
    expect(fs.readdirSync(userData)).toEqual([]);
  });

  it("status: what runs, and that nothing was refused, when nothing was", async () => {
    const { answer } = deps();
    expect(answerQuestion({ command: "status", id: ID }, answer)).toBe(true);
    expect(await replyFor()).toEqual({
      code: 0,
      text:
        "Reload 1.2.3 is running (process 4000).\n" +
        "  runtime: running (process 4242)\n" +
        "  services: running (process 4243)\n" +
        "  Anytype: opened by you; Reload leaves it running\n" +
        "Nothing was refused, and nothing is held back.\n",
    });
  });

  it("status: a refusal is named once, in the notification's words, however often it was raised", async () => {
    const board = new NoticeBoard({
      deliver: () => undefined,
      store: new JsonNoticeFile(path.join(userData, NOTICES_FILENAME)),
      logger: new RecordingLogger(),
    });
    const refused: Notice = {
      kind: "package-update-refused",
      subject: "reload_folder",
      version: "2.0.0",
      detail: "Its signature does not match the catalogue",
    };
    board.raise(refused);
    board.raise(refused);
    board.raise({ ...refused });
    // A run's notice is news of the moment, not a condition: status leaves it out.
    board.raise({ kind: "run-done", subject: "flow-1", title: "Done", detail: "It ran." });
    const { answer } = deps({
      running: running({
        supervisors: new Map([["runtime", child("runtime", null, "down-for-good")]]),
        anytype: { state: null, startedPid: null },
      }),
    });
    answerQuestion({ command: "status", id: ID }, answer);
    const { title, body } = compose(refused);
    expect((await replyFor()).text).toBe(
      "Reload 1.2.3 is running (process 4000).\n" +
        "  runtime: down-for-good — It stopped 5 times in 2 minutes.\n" +
        "  Anytype: starting\n" +
        `  ${title} — ${body}\n`,
    );
  });

  it("status: a notice file it cannot read is said, not taken for nothing", async () => {
    fs.writeFileSync(path.join(userData, NOTICES_FILENAME), "{ not json");
    const { answer } = deps();
    answerQuestion({ command: "status", id: ID }, answer);
    expect((await replyFor()).text).toContain("What needs your attention could not be read");
  });

  it("log: where the log is, and its end", async () => {
    const file = path.join(userData, "reload.log");
    const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, n) => `line ${String(n)}`);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const { answer } = deps({ running: running({ log: { path: file } }) });
    answerQuestion({ command: "log", id: ID }, answer);
    const { code, text } = await replyFor();
    expect(code).toBe(0);
    expect(text.split("\n")).toEqual([
      `Log file: ${file}`,
      `  ${String(fs.statSync(file).size)} bytes; the last lines:`,
      ...lines.slice(-LOG_TAIL_LINES),
      "",
    ]);
  });

  it("log: says when nothing is written yet, or no log could be opened", async () => {
    const file = path.join(userData, "reload.log");
    answerQuestion(
      { command: "log", id: ID },
      deps({ running: running({ log: { path: file } }) }).answer,
    );
    expect((await replyFor()).text).toBe(`Log file: ${file}\n  nothing written yet.\n`);
    const other = "fedcba9876543210fedcba9876543210";
    answerQuestion({ command: "log", id: other }, deps().answer);
    expect((await replyFor(other)).text).toBe("Reload could not open a log file in this run.\n");
  });

  it("quit: takes the Quit menu's path, says what stopped, then that Reload is off", async () => {
    const { answer, quits } = deps();
    answerQuestion({ command: "quit", id: ID }, answer);
    expect(await replyFor()).toEqual({
      code: 0,
      text:
        "  runtime stopped (process 4242)\n" +
        "  services stopped (process 4243)\n" +
        "Reload is off.\n",
    });
    expect(quits).toEqual(["quit"]);
  });

  it("quit: a quit cancelled in the window is said, with exit 1; one under way is said too", async () => {
    answerQuestion(
      { command: "quit", id: ID },
      deps({ quit: () => Promise.resolve("cancelled") }).answer,
    );
    expect(await replyFor()).toEqual({
      code: 1,
      text: "The quit was cancelled in Reload's window. Reload is still running.\n",
    });
    const other = "fedcba9876543210fedcba9876543210";
    answerQuestion(
      { command: "quit", id: other },
      deps({ quit: () => Promise.resolve("busy") }).answer,
    );
    expect(await replyFor(other)).toEqual({ code: 0, text: "Reload is already quitting.\n" });
  });

  it("says once in the log when its answer cannot be written, instead of failing", async () => {
    const gone = path.join(userData, "gone");
    const { answer, logger } = deps({
      app: { getPath: () => gone, getVersion: () => "1.2.3" },
    });
    answerQuestion({ command: "status", id: ID }, answer);
    await expect
      .poll(() => logger.lines.filter((line) => line.startsWith("WARN")))
      .toEqual([expect.stringContaining("could not be written")]);
  });
});

describe("the shell's second launch", () => {
  it("answers a question instead of bringing the window forward, and quits by the Quit path", async () => {
    const app = Object.assign(new EventEmitter(), {
      requestSingleInstanceLock: () => true,
      exit: () => undefined,
      isReady: () => true,
      quit: () => undefined,
      getPath: () => userData,
      getVersion: () => "1.2.3",
    });
    const requests: { ask: boolean }[] = [];
    let forward = 0;
    runShell({
      app: app as never,
      signals: new EventEmitter() as never,
      quitFlow: {
        done: false,
        request: (options) => {
          requests.push(options);
          return Promise.resolve("quit");
        },
      },
      bringForward: () => {
        forward += 1;
      },
      windowOpen: () => true,
      running: running(),
      start: () => Promise.resolve(),
      logger: new RecordingLogger(),
    });
    app.emit("second-instance", {}, [], "/", { command: "quit", id: ID });
    expect((await replyFor()).text).toContain("Reload is off.");
    expect(requests).toEqual([{ ask: true }]);
    app.emit("second-instance", {}, [], "/", undefined);
    expect(forward).toBe(1);
  });
});
