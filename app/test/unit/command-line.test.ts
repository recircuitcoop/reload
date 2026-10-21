// Reload from a terminal (plan 0031 group E): `reload --status` and `--quit` ask the running
// instance over the single-instance channel and print its answer, read back from a file of this
// user's own in the user-data folder; `--status` answers from the files when nothing runs or the
// instance does not answer, and `--log` asks nobody.
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
  logText,
  removeStaleReplies,
  replyFile,
  STALE_REPLY_MS,
  unwritable,
  WAIT_MS,
  type AnswerDeps,
  type Asked,
  type Reply,
  type Running,
} from "../../src/shell/command-line";
import { runShell } from "../../src/shell/lifecycle";
import { RUN_STATE_FILENAME, type RunRecord } from "../../src/shell/run-state";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

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

const anytype = (state: Running["anytype"]["state"]): Running["anytype"] => ({
  state,
  startedPid: null,
  onStarted: () => undefined,
});

function running(overrides: Partial<Running> = {}): Running {
  return {
    supervisors: new Map([
      ["services", child("services", 4243)],
      ["runtime", child("runtime", 4242)],
    ]),
    anytype: anytype("adopted"),
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
    replies: unwritable("answer to a terminal command", () => null, logger),
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

const writeRunState = (records: RunRecord[]) => {
  fs.writeFileSync(path.join(userData, RUN_STATE_FILENAME), JSON.stringify(records));
};

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
  /**
   * A second launch. `alive` is the process table (pid to identity); `onAsk` stands for the
   * running instance, called with the question when the lock is taken.
   */
  function asking(
    lockFree: boolean,
    onAsk?: (data: unknown) => void,
    alive = new Map<number, string>(),
  ) {
    const printed: string[] = [];
    let clock = 0;
    const sent: unknown[] = [];
    const code = (command: Asked) =>
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
        identity: (pid) => alive.get(pid) ?? null,
        notices: NOTICES_FILENAME,
      });
    return { code, printed, sent, alive };
  }

  const answers = (reply: Reply) => () => {
    fs.writeFileSync(replyFile(userData, ID), JSON.stringify(reply));
  };

  it("status with nothing running: says nothing is running, from the files, and exits 0", () => {
    const { code, printed } = asking(true);
    expect(code("status")).toBe(0);
    expect(printed.join("")).toBe(
      "Nothing is running.\nNothing was refused, and nothing is held back.\n",
    );
  });

  it("status with nothing running still names a stopped child and a staged update, with no notification ever shown", () => {
    // Written to the notice file and nothing else: no notifier exists, so none was ever shown.
    const stopped: Notice = {
      kind: "child-stopped",
      subject: "runtime",
      detail: "It stopped 5 times in 2 minutes",
    };
    const staged: Notice = { kind: "core-update-available", subject: "Reload", version: "1.5.0" };
    new JsonNoticeFile(path.join(userData, NOTICES_FILENAME)).write([stopped, staged]);
    const { code, printed } = asking(true);
    expect(code("status")).toBe(0);
    const words = (notice: Notice) => `  ${compose(notice).title} — ${compose(notice).body}`;
    expect(printed.join("")).toBe(`Nothing is running.\n${words(stopped)}\n${words(staged)}\n`);
    expect(printed.join("")).toContain("Reload stopped restarting the runtime");
    expect(printed.join("")).toContain("Reload 1.5.0 is ready");
  });

  it("status with nothing running names a recorded process that still runs", () => {
    writeRunState([
      { id: "shell", pid: 10, identity: "t0 Reload" },
      { id: "runtime", pid: 11, identity: "t1 Reload runtime" },
    ]);
    const { code, printed } = asking(true, undefined, new Map([[11, "t1 Reload runtime"]]));
    expect(code("status")).toBe(0);
    expect(printed.join("")).toBe(
      "  runtime: running (process 11)\nNothing was refused, and nothing is held back.\n",
    );
  });

  it("quit with nothing running says plainly that Reload is not running, and exits 1", () => {
    const { code, printed } = asking(true);
    expect(code("quit")).toBe(1);
    expect(printed).toEqual(["Reload is not running.\n"]);
  });

  it("sends the command and its id, prints the answer, and removes the answer file", () => {
    const { code, printed, sent } = asking(false, answers({ code: 0, text: "Reload is up.\n" }));
    expect(code("status")).toBe(0);
    expect(sent).toEqual([{ command: "status", id: ID }]);
    expect(printed).toEqual(["Reload is up.\n"]);
    expect(fs.readdirSync(userData)).toEqual([]);
  });

  it("status that gets no answer in time says so, then answers from the files", () => {
    writeRunState([{ id: "shell", pid: 10, identity: "t0 Reload" }]);
    const { code, printed } = asking(false, undefined, new Map([[10, "t0 Reload"]]));
    expect(code("status")).toBe(0);
    expect(printed.join("")).toBe(
      `Reload did not answer within ${String(WAIT_MS.status / 1000)} seconds.\n` +
        "  shell: running (process 10)\n" +
        "Nothing was refused, and nothing is held back.\n",
    );
  });

  it("quit that gets no answer in time says so, exits 1, and removes its answer file", () => {
    // An answer it cannot read yet: given up on, it is removed, not left behind.
    const { code, printed } = asking(false, () => {
      fs.writeFileSync(replyFile(userData, ID), "{}", { mode: 0o000 });
    });
    expect(code("quit")).toBe(1);
    expect(printed).toEqual([
      `Reload did not answer within ${String(WAIT_MS.quit / 1000)} seconds.\n`,
    ]);
    expect(fs.readdirSync(userData)).toEqual([]);
  });

  it("an answer that is not one is said, with exit 1", () => {
    const { code, printed } = asking(false, () => {
      fs.writeFileSync(replyFile(userData, ID), '{"code":"0"}');
    });
    expect(code("status")).toBe(1);
    expect(printed).toEqual(["Reload's answer could not be read.\n"]);
  });

  it("quit: names what stopped, and what still runs after the quit, never a process that had none", () => {
    // Recorded: the shell, the runtime, an Anytype Reload started, and the services process
    // whose pid is another program's by now (it had stopped for good; never named "stopped").
    writeRunState([
      { id: "shell", pid: 10, identity: "t0 Reload" },
      { id: "runtime", pid: 11, identity: "t1 Reload runtime" },
      { id: "services", pid: 12, identity: "t2 Reload services" },
      { id: "anytype", pid: 13, identity: "t3 Anytype" },
    ]);
    const alive = new Map([
      [10, "t0 Reload"],
      [11, "t1 Reload runtime"],
      [12, "t9 somebody's editor"],
      [13, "t3 Anytype"],
    ]);
    const { code, printed } = asking(
      false,
      () => {
        alive.delete(10);
        alive.delete(11);
        answers({ code: 0, text: "" })();
      },
      alive,
    );
    expect(code("quit")).toBe(0);
    expect(printed.join("")).toBe(
      "  shell stopped (process 10)\n" +
        "  runtime stopped (process 11)\n" +
        "anytype (process 13) is still running after the quit.\n",
    );
  });

  it("quit: says Reload is off once every process it ran is gone", () => {
    writeRunState([
      { id: "shell", pid: 10, identity: "t0 Reload" },
      { id: "anytype", pid: 13, identity: "t3 Anytype" },
    ]);
    const alive = new Map([
      [10, "t0 Reload"],
      [13, "t3 Anytype"],
    ]);
    const { code, printed } = asking(
      false,
      () => {
        alive.clear();
        answers({ code: 0, text: "Reload is already quitting.\n" })();
      },
      alive,
    );
    expect(code("quit")).toBe(0);
    expect(printed.join("")).toBe(
      "Reload is already quitting.\n" +
        "  shell stopped (process 10)\n" +
        "  anytype stopped (process 13)\n" +
        "Reload is off.\n",
    );
  });

  it("quit: a cancelled quit is said and checks nothing; an unreadable record is said", () => {
    const cancelled = "The quit was cancelled in Reload's window. Reload is still running.\n";
    const first = asking(false, answers({ code: 1, text: cancelled }));
    expect(first.code("quit")).toBe(1);
    expect(first.printed).toEqual([cancelled]);
    fs.writeFileSync(path.join(userData, RUN_STATE_FILENAME), '[{"id":"shell"}]');
    const second = asking(false, answers({ code: 0, text: "" }));
    expect(second.code("quit")).toBe(0);
    expect(second.printed.join("")).toBe(
      "Reload quit, but what it ran could not be checked: The run-state file could not be " +
        "read: it is not a list of the processes Reload ran.\n",
    );
  });
});

describe("reload --log asks nobody", () => {
  it("names the log and shows its end, with nothing running", () => {
    const file = path.join(userData, "reload.log");
    const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, n) => `line ${String(n)}`);
    lines.push("a line somebody went looking for");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const text = logText(file);
    expect(text.split("\n")).toEqual([
      `Log file: ${file}`,
      `  ${String(fs.statSync(file).size)} bytes; the last lines:`,
      ...lines.slice(-LOG_TAIL_LINES),
      "",
    ]);
    expect(text).toContain("a line somebody went looking for");
  });

  it("names the log's place whether or not anything was written there yet", () => {
    const file = path.join(userData, "Logs", "reload.log");
    expect(logText(file)).toBe(
      `Log file: ${file}\n  nothing written yet: no Reload process has logged on this machine.\n`,
    );
  });
});

describe("the running instance answers", () => {
  it("leaves an ordinary launch, and a question it cannot trust, to bring the window forward", () => {
    const { answer } = deps();
    expect(answerQuestion(undefined, answer)).toBe(false);
    expect(answerQuestion({ command: "status", id: "../../elsewhere" }, answer)).toBe(false);
    expect(answerQuestion({ command: "rm", id: ID }, answer)).toBe(false);
    expect(answerQuestion({ command: "log", id: ID }, answer)).toBe(false);
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
        anytype: anytype(null),
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

  it("quit: takes the Quit menu's path, and leaves naming what stopped to the asking process", async () => {
    const { answer, quits } = deps();
    answerQuestion({ command: "quit", id: ID }, answer);
    expect(await replyFor()).toEqual({ code: 0, text: "" });
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

  it("an answer that cannot be written is a notice told once however often it fails, cleared once one is written", async () => {
    const gone = path.join(userData, "gone");
    const notifier = new RecordingNotifier();
    const logger = new RecordingLogger();
    const replies = unwritable("answer to a terminal command", () => notifier, logger);
    const answer = deps({
      app: { getPath: () => gone, getVersion: () => "1.2.3" },
      replies,
    }).answer;
    const ids = ["1", "2", "3"].map((digit) => digit.repeat(32));
    for (const id of ids) {
      answerQuestion({ command: "status", id }, answer);
    }
    await expect.poll(() => notifier.notices.length).toBe(1);
    // The failures after the first change nothing: said once, then silence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notifier.notices).toEqual([
      {
        kind: "command-line-unwritable",
        subject: "answer to a terminal command",
        detail: expect.stringContaining("ENOENT") as unknown,
      },
    ]);
    expect(compose(notifier.notices[0] as Notice).title).toBe(
      "Reload could not write its answer to a terminal command",
    );
    expect(logger.lines.filter((line) => !line.startsWith("INFO answering"))).toEqual([]);
    fs.mkdirSync(gone);
    answerQuestion({ command: "status", id: ID }, answer);
    await expect
      .poll(() => notifier.cleared)
      .toEqual(["command-line-unwritable answer to a terminal command"]);
  });

  it("an answer that cannot be written before the notices exist is a warning in the log, once", async () => {
    const logger = new RecordingLogger();
    const replies = unwritable("answer to a terminal command", () => null, logger);
    const gone = { getPath: () => path.join(userData, "gone"), getVersion: () => "1.2.3" };
    answerQuestion({ command: "status", id: ID }, deps({ app: gone, replies, logger }).answer);
    answerQuestion(
      { command: "status", id: "1".repeat(32) },
      deps({ app: gone, replies, logger }).answer,
    );
    await expect
      .poll(() => logger.lines.filter((line) => line.startsWith("WARN")))
      .toEqual([
        expect.stringContaining("Reload could not write its answer to a terminal command"),
      ]);
  });
});

describe("answers nobody took", () => {
  it("are removed at the next start once a few minutes old, by name only, a link never followed", () => {
    const now = Date.now();
    const old = (now - STALE_REPLY_MS - 1000) / 1000;
    const stale = replyFile(userData, ID);
    const scratch = `${replyFile(userData, "a".repeat(32))}.tmp`;
    const fresh = replyFile(userData, "b".repeat(32));
    const link = replyFile(userData, "c".repeat(32));
    const outside = path.join(userData, "kept", "notes.txt");
    const other = path.join(userData, "settings.json");
    fs.mkdirSync(path.dirname(outside));
    for (const file of [stale, scratch, fresh, outside, other]) fs.writeFileSync(file, "{}");
    fs.symlinkSync(outside, link);
    for (const file of [stale, scratch, outside, other]) fs.utimesSync(file, old, old);
    fs.lutimesSync(link, old, old);
    removeStaleReplies(userData, now);
    expect(fs.readdirSync(userData).sort()).toEqual(
      [path.basename(fresh), "kept", "settings.json"].sort(),
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("{}");
  });
});

describe("the shell's second launch", () => {
  it("answers a question instead of bringing the window forward, and quits by the Quit path", async () => {
    // An answer a killed asker left behind long ago: the start removes it.
    const left = replyFile(userData, "d".repeat(32));
    fs.writeFileSync(left, "{}");
    const old = (Date.now() - STALE_REPLY_MS * 2) / 1000;
    fs.utimesSync(left, old, old);
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
      start: () => Promise.resolve(null),
      logger: new RecordingLogger(),
    });
    expect(fs.existsSync(left)).toBe(false);
    app.emit("second-instance", {}, [], "/", { command: "quit", id: ID });
    expect(await replyFor()).toEqual({ code: 0, text: "" });
    expect(requests).toEqual([{ ask: true }]);
    app.emit("second-instance", {}, [], "/", undefined);
    expect(forward).toBe(1);
  });
});
