// Reload from a terminal (plan 0031 group E): `reload --status` and `--quit` leave a question
// file in the user-data folder, never take the single-instance lock, and read the answer back
// from a file of this user's own; `--status` answers from the files when nothing runs or the
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
  removeStaleReplies,
  takeQuestions,
  unwritable,
  type AnswerDeps,
  type Running,
} from "../../src/shell/command-answers";
import {
  ask,
  commandOf,
  LOG_TAIL_LINES,
  logText,
  namesOf,
  PICKUP_MS,
  questionFile,
  replyFile,
  stdoutWriter,
  STALE_REPLY_MS,
  WAIT_MS,
  isQuestion,
  type Asked,
  type Question,
  type Reply,
} from "../../src/shell/command-line";
import { runShell } from "../../src/shell/lifecycle";
import {
  identityOf,
  plainText,
  RUN_STATE_FILENAME,
  UncheckedIdentity,
  writePrivateFile,
  type RunRecord,
} from "../../src/shell/run-state";
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
    replies: unwritable("answers to terminal commands", () => null, logger),
    questions: unwritable("questions from terminal commands", () => null, logger),
    askerRuns: () => Promise.resolve(true),
    logger,
    ...overrides,
  };
  return { answer, logger, quits };
}

/** The asking process, and its identity as the process table gives it. */
const ASKER = { pid: 4321, identity: "t9 /Applications/Reload.app/Contents/MacOS/Reload --quit" };
const EXECUTABLE = "/Applications/Reload.app/Contents/MacOS/Reload";

/** A question as the asking process leaves it. */
const put = (command: string, id = ID) => {
  writePrivateFile(questionFile(userData, id), JSON.stringify({ command, id, ...ASKER }));
};

/** The reply the running instance wrote for the question, once it is there. */
async function replyFor(id = ID): Promise<Reply> {
  const file = replyFile(userData, id);
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Reply;
}

const runStateFile = () => path.join(userData, RUN_STATE_FILENAME);
const writeRunState = (records: RunRecord[]) => {
  fs.writeFileSync(runStateFile(), JSON.stringify(records));
};
const SHELL: RunRecord = { id: "shell", pid: 10, identity: "t0 Reload" };

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

  it("ends a command whose reader went away with its own exit code, never a throw", () => {
    const written: string[] = [];
    let calls = 0;
    const print = stdoutWriter(
      (bytes) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("full"), { code: "EAGAIN" });
        if (calls === 2) {
          // Half of it: the rest is written next.
          written.push(Buffer.from(bytes.subarray(0, 3)).toString());
          return 3;
        }
        if (calls === 3) {
          written.push(Buffer.from(bytes).toString());
          return bytes.length;
        }
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
      () => undefined,
    );
    print("Reload is up.\n");
    expect(written.join("")).toBe("Reload is up.\n");
    expect(() => {
      print("more\n");
      print("and more\n");
    }).not.toThrow();
    expect(calls).toBe(4);
  });

  it("prints plain text: no control character but the newline and the tab", () => {
    expect(plainText("a\u001b]0;owned\u0007b\tc\r\n\u009bd\u007f")).toBe("a]0;ownedb\tc\nd");
  });
});

describe("the asking process", () => {
  /**
   * A second launch, with no single-instance lock to take (its app has getPath alone). `alive`
   * is the process table; `instance` stands for the running Reload: called with each question
   * it takes, it answers with a reply, or null for none. Without it, nobody takes a question.
   */
  function asking(
    options: {
      alive?: Map<number, string>;
      instance?: (question: Question) => Reply | null;
      identity?: (pid: number) => string | null;
    } = {},
  ) {
    const alive = options.alive ?? new Map<number, string>();
    const printed: string[] = [];
    const taken: { question: Question; mode: number }[] = [];
    let clock = 0;
    const code = (command: Asked) =>
      ask(command, {
        app: { getPath: () => userData },
        print: (text) => printed.push(text),
        id: ID,
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          const file = questionFile(userData, ID);
          if (options.instance === undefined || !fs.existsSync(file)) return;
          const question = JSON.parse(fs.readFileSync(file, "utf8")) as Question;
          taken.push({ question, mode: fs.statSync(file).mode & 0o777 });
          fs.unlinkSync(file);
          const reply = options.instance(question);
          if (reply !== null) fs.writeFileSync(replyFile(userData, ID), JSON.stringify(reply));
        },
        identity: (pid) =>
          pid === ASKER.pid
            ? ASKER.identity
            : (options.identity ?? ((other: number) => alive.get(other) ?? null))(pid),
        notices: NOTICES_FILENAME,
        pid: ASKER.pid,
        executable: EXECUTABLE,
      });
    return { code, printed, taken, alive, out: () => printed.join("") };
  }

  it("status with nothing running: says nothing is running, from the files, and exits 0", () => {
    const { code, out } = asking();
    expect(code("status")).toBe(0);
    expect(out()).toBe("Nothing is running.\nNothing was refused, and nothing is held back.\n");
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
    const { code, out } = asking();
    expect(code("status")).toBe(0);
    const words = (notice: Notice) => `  ${compose(notice).title} — ${compose(notice).body}`;
    expect(out()).toBe(`Nothing is running.\n${words(stopped)}\n${words(staged)}\n`);
    expect(out()).toContain("Reload stopped restarting the runtime");
    expect(out()).toContain("Reload 1.5.0 is ready");
  });

  it("status with nothing running names a recorded process that still runs", () => {
    writeRunState([SHELL, { id: "runtime", pid: 11, identity: "t1 Reload runtime" }]);
    const { code, out } = asking({ alive: new Map([[11, "t1 Reload runtime"]]) });
    expect(code("status")).toBe(0);
    expect(out()).toBe(
      "  runtime: running (process 11)\nNothing was refused, and nothing is held back.\n",
    );
  });

  it("says Reload is starting while it holds the single-instance lock before its first record", () => {
    fs.symlinkSync("my-mac.local-4242", path.join(userData, "SingletonLock"));
    const holder = new Map([[4242, `t8 ${EXECUTABLE}`]]);
    const quit = asking({ alive: holder });
    expect(quit.code("quit")).toBe(1);
    expect(quit.printed).toEqual([
      "Reload is starting and cannot answer yet. Try again in a moment.\n",
    ]);
    const status = asking({ alive: holder });
    expect(status.code("status")).toBe(0);
    expect(status.printed).toEqual(quit.printed);
    // A lock left by a Reload that is gone, its pid another program's now: not a start.
    const left = asking({ alive: new Map([[4242, "t2 /usr/bin/vim notes.txt"]]) });
    expect(left.code("quit")).toBe(1);
    expect(left.printed).toEqual(["Reload is not running.\n"]);
  });

  it("quit with nothing running says plainly that Reload is not running, and exits 1", () => {
    // A record left by a Reload that is gone, its pid another program's now: not running.
    writeRunState([SHELL]);
    const { code, printed, taken } = asking({ alive: new Map([[10, "t9 somebody's editor"]]) });
    expect(code("quit")).toBe(1);
    expect(printed).toEqual(["Reload is not running.\n"]);
    expect(taken).toEqual([]);
  });

  it("asks with a question file of its own, never the single-instance lock, prints the answer and removes both files", () => {
    writeRunState([SHELL]);
    const { code, printed, taken } = asking({
      alive: new Map([[10, "t0 Reload"]]),
      instance: () => ({ code: 0, text: "Reload is up.\n" }),
    });
    expect(code("status")).toBe(0);
    expect(taken).toEqual([{ question: { command: "status", id: ID, ...ASKER }, mode: 0o600 }]);
    expect(printed).toEqual(["Reload is up.\n"]);
    expect(fs.readdirSync(userData)).toEqual([RUN_STATE_FILENAME]);
  });

  it("a Reload that does not take the question in time: said, the question taken back, then what the files say", () => {
    writeRunState([SHELL]);
    const stuck = asking({ alive: new Map([[10, "t0 Reload"]]) });
    expect(stuck.code("status")).toBe(0);
    expect(stuck.out()).toBe(
      `Reload did not answer within ${String(PICKUP_MS / 1000)} seconds.\n` +
        "  shell: running (process 10)\n" +
        "Nothing was refused, and nothing is held back.\n",
    );
    expect(stuck.code("quit")).toBe(1);
    expect(stuck.printed.at(-1)).toBe(
      `Reload did not answer within ${String(PICKUP_MS / 1000)} seconds.\n`,
    );
    // Taken back: a Reload that wakes later finds no question to act on.
    expect(fs.readdirSync(userData)).toEqual([RUN_STATE_FILENAME]);
  });

  it("a question taken and never answered: said after the command's wait, and a late answer removed", () => {
    writeRunState([SHELL]);
    const { code, out } = asking({
      alive: new Map([[10, "t0 Reload"]]),
      instance: () => {
        // An answer it cannot read: given up on, it is removed, not left behind.
        fs.writeFileSync(replyFile(userData, ID), "{}", { mode: 0o000 });
        return null;
      },
    });
    expect(code("status")).toBe(0);
    expect(out()).toMatch(
      new RegExp(`^Reload did not answer within ${String(WAIT_MS.status / 1000)} seconds\\.\\n`),
    );
    expect(fs.readdirSync(userData)).toEqual([RUN_STATE_FILENAME]);
  });

  it("an answer that is not one is said, with exit 1, and nothing in an answer drives the terminal", () => {
    writeRunState([SHELL]);
    const alive = new Map([[10, "t0 Reload"]]);
    const bad = asking({ alive, instance: () => ({ code: "0", text: "" }) as unknown as Reply });
    expect(bad.code("status")).toBe(1);
    expect(bad.printed).toEqual(["Reload's answer could not be read.\n"]);
    const loud = asking({
      alive,
      instance: () => ({ code: 0, text: "\u001b]0;owned\u0007Reload is up.\r\n" }),
    });
    expect(loud.code("status")).toBe(0);
    expect(loud.printed).toEqual(["]0;ownedReload is up.\n"]);
  });

  it("status from the files says a process it could not check, and never takes it for gone", () => {
    writeRunState([SHELL, { id: "runtime", pid: 11, identity: "t1 Reload runtime" }]);
    const { code, out } = asking({
      identity: (pid) => {
        if (pid === 11) throw new UncheckedIdentity("the process table could not be read: EPERM");
        return null;
      },
    });
    expect(code("status")).toBe(0);
    expect(out()).toBe(
      "  runtime: could not be checked (process 11): the process table could not be read: EPERM\n" +
        "Nothing was refused, and nothing is held back.\n",
    );
  });

  it("quit: names what stopped, and what still runs after the quit, never a process that had none", () => {
    // Recorded: the shell, the runtime, an Anytype Reload started, and the services process
    // whose pid is another program's by now (it had stopped for good; never named "stopped").
    writeRunState([
      SHELL,
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
    const { code, out } = asking({
      alive,
      instance: () => {
        alive.delete(10);
        alive.delete(11);
        return { code: 0, text: "" };
      },
    });
    // What did not stop is the one case the command did not do what it promised: exit 1.
    expect(code("quit")).toBe(1);
    expect(out()).toBe(
      "  shell stopped (process 10)\n" +
        "  runtime stopped (process 11)\n" +
        "anytype (process 13) is still running after the quit.\n",
    );
    expect(fs.existsSync(runStateFile())).toBe(true);
  });

  it("quit: reads the record again after the quit, so a child restarted with a new pid is checked too", () => {
    writeRunState([SHELL, { id: "runtime", pid: 11, identity: "t1 Reload runtime" }]);
    const alive = new Map([
      [10, "t0 Reload"],
      [11, "t1 Reload runtime"],
    ]);
    const { code, out } = asking({
      alive,
      instance: () => {
        // The runtime restarted while Reload quit, and the restart outlived the quit.
        alive.delete(11);
        alive.set(21, "t5 Reload runtime");
        writeRunState([SHELL, { id: "runtime", pid: 21, identity: "t5 Reload runtime" }]);
        alive.delete(10);
        return { code: 0, text: "" };
      },
    });
    expect(code("quit")).toBe(1);
    expect(out()).toBe(
      "  shell stopped (process 10)\n" +
        "  runtime stopped (process 11)\n" +
        "runtime (process 21) is still running after the quit.\n",
    );
  });

  it("quit: gives the shell the quit's own wait to end, not a fixed polite stop", () => {
    writeRunState([SHELL]);
    let clock = 0;
    let asked = false;
    const printed: string[] = [];
    const code = ask("quit", {
      app: { getPath: () => userData },
      print: (text) => printed.push(text),
      id: ID,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        const file = questionFile(userData, ID);
        if (asked || !fs.existsSync(file)) return;
        asked = true;
        fs.unlinkSync(file);
        fs.writeFileSync(replyFile(userData, ID), JSON.stringify({ code: 0, text: "" }));
      },
      // The shell stops its children first, under load slowly: it is gone 40 s after it answered.
      identity: (pid) => {
        if (pid === ASKER.pid) return ASKER.identity;
        return pid === 10 && (!asked || clock < 40_000) ? "t0 Reload" : null;
      },
      notices: NOTICES_FILENAME,
      pid: ASKER.pid,
      executable: EXECUTABLE,
    });
    expect(printed.join("")).toBe("  shell stopped (process 10)\nReload is off.\n");
    expect(code).toBe(0);
  });

  it("quit: says Reload is off once every process it ran is gone, and no run-state is left", () => {
    writeRunState([SHELL, { id: "anytype", pid: 13, identity: "t3 Anytype" }]);
    const alive = new Map([
      [10, "t0 Reload"],
      [13, "t3 Anytype"],
    ]);
    const { code, out } = asking({
      alive,
      instance: () => {
        // A shell that ended without removing its record: the record goes all the same.
        alive.clear();
        return { code: 0, text: "Reload is already quitting.\n" };
      },
    });
    expect(code("quit")).toBe(0);
    expect(out()).toBe(
      "Reload is already quitting.\n" +
        "  shell stopped (process 10)\n" +
        "  anytype stopped (process 13)\n" +
        "Reload is off.\n",
    );
    expect(fs.existsSync(runStateFile())).toBe(false);
  });

  it("quit: a cancelled quit is said and checks nothing", () => {
    writeRunState([SHELL]);
    const cancelled = "The quit was cancelled in Reload's window. Reload is still running.\n";
    const first = asking({
      alive: new Map([[10, "t0 Reload"]]),
      instance: () => ({ code: 1, text: cancelled }),
    });
    expect(first.code("quit")).toBe(1);
    expect(first.printed).toEqual([cancelled]);
  });

  it("status with an unreadable record and nothing running says so at once, then the notices", () => {
    fs.writeFileSync(runStateFile(), '[{"id":"shell"}]');
    const { code, out, taken } = asking();
    expect(code("status")).toBe(0);
    expect(out()).toBe(
      "The run-state file could not be read: record 1 has no valid pid.\n" +
        `It is ${runStateFile()}. No Reload is running, so \`reload --quit --force\` removes ` +
        "it once nothing it names runs.\n" +
        "Nothing was refused, and nothing is held back.\n",
    );
    // No question was left for a Reload that is not there, and no wait on one.
    expect(taken).toEqual([]);
    expect(fs.readdirSync(userData)).toEqual([RUN_STATE_FILENAME]);
  });

  it("quit with an unreadable record and nothing running says what is wrong, where, and what to do", () => {
    fs.writeFileSync(runStateFile(), '[{"id":"shell"}]');
    const { code, out, taken } = asking({ instance: () => ({ code: 0, text: "" }) });
    expect(code("quit")).toBe(1);
    expect(out()).toBe(
      "The run-state file could not be read: record 1 has no valid pid.\n" +
        `It is ${runStateFile()}. No Reload is running, so \`reload --quit --force\` removes ` +
        "it once nothing it names runs.\n",
    );
    expect(taken).toEqual([]);
  });

  it("quit with an unreadable record asks a Reload that holds the lock, and says what it could not check", () => {
    fs.writeFileSync(runStateFile(), '[{"id":"shell"}]');
    fs.symlinkSync("my-mac.local-4242", path.join(userData, "SingletonLock"));
    const { code, out } = asking({
      alive: new Map([[4242, `t8 ${EXECUTABLE}`]]),
      instance: () => ({ code: 0, text: "" }),
    });
    expect(code("quit")).toBe(1);
    expect(out()).toBe(
      "Reload quit, but what it ran could not be checked: The run-state file could not be " +
        "read: record 1 has no valid pid.\n",
    );
  });

  it("quit: a process it could not check is said, and Reload is not said to be off", () => {
    writeRunState([SHELL]);
    let quit = false;
    const { code, out } = asking({
      identity: (pid) => {
        if (quit) throw new UncheckedIdentity("the process table could not be read: ETIMEDOUT");
        return pid === 10 ? "t0 Reload" : null;
      },
      instance: () => {
        quit = true;
        return { code: 0, text: "" };
      },
    });
    expect(code("quit")).toBe(1);
    expect(out()).toBe(
      "shell (process 10) could not be checked: the process table could not be read: ETIMEDOUT.\n",
    );
    expect(fs.existsSync(runStateFile())).toBe(true);
  });
});

describe("reload --log asks nobody", () => {
  it("names the log and shows its end, with nothing running", () => {
    const file = path.join(userData, "reload.log");
    const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, n) => `line ${String(n)}`);
    lines.push("a line somebody went looking for");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const { code, text } = logText(file);
    expect(code).toBe(0);
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
    expect(logText(file)).toEqual({
      code: 0,
      text: `Log file: ${file}\n  nothing written yet: no Reload process has logged on this machine.\n`,
    });
  });

  it("exits 1 when there is a log and it cannot be read", () => {
    // A folder where the log should be: there, and not a file it can read.
    const file = path.join(userData, "reload.log");
    fs.mkdirSync(file);
    const { code, text } = logText(file);
    expect(code).toBe(1);
    expect(text).toMatch(new RegExp(`^Log file: ${file}\\n {2}it could not be read: .*EISDIR`));
  });

  it("never lets a logged line drive the terminal", () => {
    const file = path.join(userData, "reload.log");
    fs.writeFileSync(file, "a title \u001b]0;owned\u0007 set\n");
    expect(logText(file).text.split("\n").at(-2)).toBe("a title ]0;owned set");
  });
});

describe("the running instance answers", () => {
  const take = (answer: AnswerDeps) => {
    takeQuestions(userData, answer, Date.now());
  };

  it("takes a question and removes it; anything else is removed unanswered", () => {
    const { answer } = deps();
    const ids = ["1", "2", "3", "4", "5"].map((digit) => digit.repeat(32));
    put("rm", ids[0]);
    put("log", ids[1]);
    // A question whose id is not its name's.
    writePrivateFile(
      questionFile(userData, ids[2] ?? ""),
      JSON.stringify({ command: "status", id: ID, ...ASKER }),
    );
    // A link, never followed; and a question its asker gave up on long ago.
    const elsewhere = path.join(userData, "elsewhere.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ command: "quit", id: ids[3], ...ASKER }));
    fs.symlinkSync(elsewhere, questionFile(userData, ids[3] ?? ""));
    put("quit", ids[4]);
    // Older than the pickup window: its asker gave up on it, so it is never acted on.
    const old = (Date.now() - PICKUP_MS - 1000) / 1000;
    fs.utimesSync(questionFile(userData, ids[4] ?? ""), old, old);
    take(answer);
    expect(fs.readdirSync(userData)).toEqual(["elsewhere.json"]);
  });

  it("never acts on a question whose asker is gone", async () => {
    const asked: [number, string][] = [];
    const { answer, quits } = deps({
      askerRuns: (pid, identity) => {
        asked.push([pid, identity]);
        return Promise.resolve(false);
      },
    });
    put("quit");
    take(answer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toEqual([[ASKER.pid, ASKER.identity]]);
    expect(quits).toEqual([]);
    expect(fs.readdirSync(userData)).toEqual([]);
  });

  it("answers an asker it cannot check, never leaving it waiting: a status as asked, a quit refused", async () => {
    const { answer, quits } = deps({ askerRuns: () => Promise.reject(new Error("ps: EPERM")) });
    put("quit");
    take(answer);
    expect(await replyFor()).toEqual({
      code: 1,
      text:
        "Reload could not check the process that asked it to quit, so it did not quit: " +
        "Error: ps: EPERM\n",
    });
    expect(quits).toEqual([]);
    const other = "e".repeat(32);
    put("status", other);
    take(answer);
    expect((await replyFor(other)).text).toMatch(/^Reload 1\.2\.3 is running \(process 4000\)/);
  });

  it("status: what runs, and that nothing was refused, when nothing was", async () => {
    const { answer } = deps();
    put("status");
    take(answer);
    expect(fs.existsSync(questionFile(userData, ID))).toBe(false);
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

  it("status: what Reload came up without is named in its exact words", async () => {
    const board = new NoticeBoard({
      deliver: () => undefined,
      store: new JsonNoticeFile(path.join(userData, NOTICES_FILENAME)),
      logger: new RecordingLogger(),
    });
    board.raise({
      kind: "endpoint-degraded",
      subject: "MCP endpoint",
      detail: "Port 31010 is used by another app",
    });
    const { answer } = deps({ running: running({ anytype: anytype("missing") }) });
    put("status");
    take(answer);
    expect((await replyFor()).text).toBe(
      "Reload 1.2.3 is running (process 4000).\n" +
        "  runtime: running (process 4242)\n" +
        "  services: running (process 4243)\n" +
        "  Anytype: not found on this machine\n" +
        "  Reload is running without its MCP endpoint — Port 31010 is used by another app. " +
        "Choose another address in Settings.\n",
    );
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
    put("status");
    take(answer);
    const { title, body } = compose(refused);
    expect((await replyFor()).text).toBe(
      "Reload 1.2.3 is running (process 4000).\n" +
        "  runtime: down-for-good — It stopped 5 times in 2 minutes.\n" +
        "  Anytype: starting\n" +
        `  ${title} — ${body}\n`,
    );
  });

  it("status: a notice file that cannot be read is read as nothing", async () => {
    const nothing = "Nothing was refused, and nothing is held back.\n";
    const ids = ["1", "2", "3"].map((digit) => digit.repeat(32));
    const files = ["{ not json", '{"kind": "core-update-available"}', '"a string"'];
    for (const [index, text] of files.entries()) {
      fs.writeFileSync(path.join(userData, NOTICES_FILENAME), text);
      put("status", ids[index]);
      take(deps().answer);
      expect(
        (await replyFor(ids[index])).text.endsWith(
          `Anytype: opened by you; Reload leaves it running\n${nothing}`,
        ),
      ).toBe(true);
    }
  });

  it("status: a notice file a newer Reload wrote keeps the lines this one understands", async () => {
    fs.writeFileSync(
      path.join(userData, NOTICES_FILENAME),
      '[{"kind": "something-invented-later", "subject": "monty"}, "not an object", ' +
        '{"kind": "core-update-available", "subject": "Reload", "version": "9.9.9", "detail": ""}]',
    );
    put("status");
    take(deps().answer);
    const staged = compose({ kind: "core-update-available", subject: "Reload", version: "9.9.9" });
    // After the shell, its two children and Anytype: the one line it has words for, alone.
    expect((await replyFor()).text.split("\n").slice(4)).toEqual([
      `  ${staged.title} — ${staged.body}`,
      "",
    ]);
  });

  it("status: a child stopped for good is reported once, not again by its notice", async () => {
    const board = new NoticeBoard({
      deliver: () => undefined,
      store: new JsonNoticeFile(path.join(userData, NOTICES_FILENAME)),
      logger: new RecordingLogger(),
    });
    board.raise({ kind: "child-stopped", subject: "runtime", detail: "It stopped 5 times." });
    const { answer } = deps({
      running: running({
        supervisors: new Map([["runtime", child("runtime", null, "down-for-good")]]),
      }),
    });
    put("status");
    take(answer);
    const { text } = await replyFor();
    expect(text.split("runtime")).toHaveLength(2);
    expect(text.endsWith("Nothing was refused, and nothing is held back.\n")).toBe(true);
  });

  it("status: every update condition, in the words of its notification", async () => {
    const conditions: Notice[] = [
      { kind: "core-update-available", subject: "Reload", version: "1.5.0" },
      { kind: "core-update-refused", subject: "Reload", detail: "Its signature does not match" },
      { kind: "core-crash-loop", subject: "Reload", version: "1.4.0" },
      { kind: "package-update-available", subject: "summarize", version: "2.0.0" },
      {
        kind: "package-update-refused",
        subject: "whodunnit",
        version: "2.0.0",
        detail: "The lock does not resolve",
      },
    ];
    new JsonNoticeFile(path.join(userData, NOTICES_FILENAME)).write(conditions);
    put("status");
    take(deps().answer);
    const { text } = await replyFor();
    for (const notice of conditions) {
      const { title, body } = compose(notice);
      expect(text).toContain(`  ${title} — ${body}\n`);
    }
    expect(text).toContain("Reload 1.5.0 is ready");
    expect(text).toContain("summarize 2.0.0 is available");
    expect(text).toContain("whodunnit 2.0.0 is being held back");
  });

  it("status: what a node sent on an undeclared port is said once, however often it was refused", async () => {
    const board = new NoticeBoard({
      deliver: () => undefined,
      store: new JsonNoticeFile(path.join(userData, NOTICES_FILENAME)),
      logger: new RecordingLogger(),
    });
    const refused: Notice = {
      kind: "emit-refused",
      subject: 'summarize (port "mounted")',
      detail: "Its package does not declare that port, so what it sent there went nowhere",
    };
    for (let n = 0; n < 25; n += 1) board.raise({ ...refused });
    put("status");
    take(deps().answer);
    const { text } = await replyFor();
    const { title, body } = compose(refused);
    expect(text.split(`  ${title} — ${body}\n`)).toHaveLength(2);
    expect(title).toBe('Reload refused what summarize (port "mounted") sent');
  });

  it("a question folder it cannot read is a notice told once however often it looks, cleared once it can", () => {
    const notifier = new RecordingNotifier();
    const questions = unwritable(
      "questions from terminal commands",
      () => notifier,
      new RecordingLogger(),
    );
    const answer = deps({ questions }).answer;
    fs.chmodSync(userData, 0o000);
    try {
      for (let n = 0; n < 5; n += 1) takeQuestions(userData, answer, Date.now());
    } finally {
      fs.chmodSync(userData, 0o700);
    }
    expect(notifier.notices).toEqual([
      {
        kind: "command-line-unwritable",
        subject: "questions from terminal commands",
        detail: expect.stringContaining("EACCES") as unknown,
      },
    ]);
    expect(compose(notifier.notices[0] as Notice).title).toBe(
      "Reload could not use its questions from terminal commands",
    );
    takeQuestions(userData, answer, Date.now());
    expect(notifier.cleared).toEqual(["command-line-unwritable questions from terminal commands"]);
  });

  it("quit: takes the Quit menu's path, and leaves naming what stopped to the asking process", async () => {
    const { answer, quits } = deps();
    put("quit");
    take(answer);
    expect(await replyFor()).toEqual({ code: 0, text: "" });
    expect(quits).toEqual(["quit"]);
  });

  it("quit: a quit cancelled in the window is said, with exit 1; one under way is said too", async () => {
    put("quit");
    take(deps({ quit: () => Promise.resolve("cancelled") }).answer);
    expect(await replyFor()).toEqual({
      code: 1,
      text: "The quit was cancelled in Reload's window. Reload is still running.\n",
    });
    const other = "fedcba9876543210fedcba9876543210";
    put("quit", other);
    take(deps({ quit: () => Promise.resolve("busy") }).answer);
    expect(await replyFor(other)).toEqual({ code: 0, text: "Reload is already quitting.\n" });
  });

  it("each question also removes the answers nobody took", () => {
    const left = replyFile(userData, "d".repeat(32));
    fs.writeFileSync(left, "{}");
    const old = (Date.now() - STALE_REPLY_MS * 2) / 1000;
    fs.utimesSync(left, old, old);
    put("status");
    take(deps().answer);
    expect(fs.existsSync(left)).toBe(false);
  });

  it("an answer that cannot be written is a notice told once however often it fails, cleared once one is written", async () => {
    const notifier = new RecordingNotifier();
    const logger = new RecordingLogger();
    const replies = unwritable("answers to terminal commands", () => notifier, logger);
    // The answers' folder is a file: every write fails, and the questions are still read.
    const answers = path.join(userData, "answers");
    fs.writeFileSync(answers, "");
    const answer = deps({
      app: { getPath: () => answers, getVersion: () => "1.2.3" },
      replies,
    }).answer;
    for (const digit of ["1", "2", "3"]) {
      put("status", digit.repeat(32));
      take(answer);
    }
    await expect.poll(() => notifier.notices.length).toBe(1);
    // The failures after the first change nothing: said once, then silence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notifier.notices).toEqual([
      {
        kind: "command-line-unwritable",
        subject: "answers to terminal commands",
        detail: expect.stringContaining("ENOTDIR") as unknown,
      },
    ]);
    expect(compose(notifier.notices[0] as Notice).title).toBe(
      "Reload could not use its answers to terminal commands",
    );
    expect(logger.lines.filter((line) => !line.startsWith("INFO answering"))).toEqual([]);
    put("status");
    take(deps({ replies }).answer);
    await expect
      .poll(() => notifier.cleared)
      .toEqual(["command-line-unwritable answers to terminal commands"]);
  });

  it("a write that fails before the notices exist is a warning, once, and a notice once they do", () => {
    const logger = new RecordingLogger();
    let notifier: RecordingNotifier | null = null;
    const trouble = unwritable("run-state file", () => notifier, logger);
    trouble.failed(new Error("EACCES"));
    trouble.failed(new Error("EACCES"));
    expect(logger.lines).toEqual(["WARN Reload could not use its run-state file: Error: EACCES"]);
    notifier = new RecordingNotifier();
    trouble.ready();
    trouble.failed(new Error("EACCES"));
    trouble.ready();
    expect(notifier.notices).toEqual([
      { kind: "command-line-unwritable", subject: "run-state file", detail: "Error: EACCES" },
    ]);
    trouble.worked();
    expect(notifier.cleared).toEqual(["command-line-unwritable run-state file"]);
    // Fixed before the notices existed: nothing to tell once they do.
    const quiet = new RecordingNotifier();
    let late: RecordingNotifier | null = null;
    const fixed = unwritable("run-state file", () => late, new RecordingLogger());
    fixed.failed(new Error("EACCES"));
    fixed.worked();
    late = quiet;
    fixed.ready();
    expect(quiet.notices).toEqual([]);
  });
});

describe("answers nobody took", () => {
  it("are removed once a few minutes old, by name only, a link never followed", () => {
    const now = Date.now();
    const old = (now - STALE_REPLY_MS - 1000) / 1000;
    const stale = replyFile(userData, ID);
    const scratch = `${replyFile(userData, "a".repeat(32))}.tmp`;
    const question = `${questionFile(userData, "e".repeat(32))}.tmp`;
    const fresh = replyFile(userData, "b".repeat(32));
    const link = replyFile(userData, "c".repeat(32));
    const outside = path.join(userData, "kept", "notes.txt");
    const other = path.join(userData, "settings.json");
    fs.mkdirSync(path.dirname(outside));
    for (const file of [stale, scratch, question, fresh, outside, other]) {
      fs.writeFileSync(file, "{}");
    }
    fs.symlinkSync(outside, link);
    for (const file of [stale, scratch, question, outside, other]) fs.utimesSync(file, old, old);
    fs.lutimesSync(link, old, old);
    removeStaleReplies(userData, now);
    expect(fs.readdirSync(userData).sort()).toEqual(
      [path.basename(fresh), "kept", "settings.json"].sort(),
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("{}");
  });
});

describe("the shell", () => {
  it("answers a question a terminal leaves, brings the window forward on a second launch, and stops looking at quit", async () => {
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
    // Asked by a process that runs (this one), checked against the real process table; a
    // question from a process that does not is left unanswered.
    const gone = "a".repeat(32);
    put("quit", gone);
    const asker = { pid: process.pid, identity: identityOf(process.pid, process.platform) };
    writePrivateFile(
      questionFile(userData, ID),
      JSON.stringify({ command: "quit", id: ID, ...asker }),
    );
    expect(await replyFor()).toEqual({ code: 0, text: "" });
    expect(fs.existsSync(replyFile(userData, gone))).toBe(false);
    expect(requests).toEqual([{ ask: true }]);
    app.emit("second-instance", {}, [], "/", undefined);
    expect(forward).toBe(1);
    // Once quit, a question is left where it is.
    app.emit("quit");
    const other = "fedcba9876543210fedcba9876543210";
    put("status", other);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fs.existsSync(questionFile(userData, other))).toBe(true);
  });
});

// The old helper's per-plugin commands (test_helper_restart.py, test_control_channel.py,
// test_helper_breaker.py): `reload --list`, and `--start`, `--stop`, `--kill`, `--restart` and
// `--release` for the packages named, each answered by the runtime, which holds the node
// processes.
describe("reload --list and the package verbs", () => {
  /** A runtime that records each call and answers it as `answer` says. */
  const runtime = (answer: (op: string, args: unknown) => unknown) => {
    const calls: [string, unknown][] = [];
    const supervisor = {
      ...child("runtime", 4242),
      call: (op: string, args: unknown) => {
        calls.push([op, args]);
        return Promise.resolve(answer(op, args) as never);
      },
    };
    return { calls, supervisor };
  };
  const ROW = { name: "ping", package: "monty", pid: 77, state: "running", why: null };
  const askWith = (command: string, names?: string[]) => {
    const question = { command, id: ID, ...ASKER, ...(names === undefined ? {} : { names }) };
    writePrivateFile(questionFile(userData, ID), JSON.stringify(question));
  };

  it("reads the package names after the flag, up to the next flag", () => {
    expect(namesOf(["Reload", "--stop", "monty", "beta", "--force"])).toEqual(["monty", "beta"]);
    expect(namesOf(["Reload", "--stop"])).toEqual([]);
    expect(commandOf(["Reload", "--release", "monty"])).toBe("release");
  });

  it("is no question when a verb names no package, or names one that is not a name", () => {
    const base = { id: ID, ...ASKER };
    expect(isQuestion({ ...base, command: "stop", names: ["monty"] })).toBe(true);
    expect(isQuestion({ ...base, command: "stop" })).toBe(false);
    expect(isQuestion({ ...base, command: "stop", names: [] })).toBe(false);
    expect(isQuestion({ ...base, command: "start", names: [7] })).toBe(false);
    expect(isQuestion({ ...base, command: "list" })).toBe(true);
    expect(isQuestion({ ...base, command: "status", names: ["monty"] })).toBe(false);
    expect(isQuestion({ ...base, command: "levitate" })).toBe(false);
  });

  it.each(["start", "stop", "restart", "kill", "release"])(
    "--%s reaches the runtime for the packages named, and its answer is reported back",
    async (verb) => {
      const { calls, supervisor } = runtime(() => ({
        ok: true,
        value: { rows: [ROW], refused: [] },
      }));
      const { answer } = deps({
        running: running({ supervisors: new Map([["runtime", supervisor]]) }),
      });
      askWith(verb, ["monty"]);
      takeQuestions(userData, answer, Date.now());
      expect(await replyFor()).toEqual({
        code: 0,
        text: "  monty › ping: running (process 77)\n",
      });
      expect(calls).toEqual([["nodes.command", { verb, names: ["monty"] }]]);
    },
  );

  it("--list answers with every node process the runtime runs, by package", async () => {
    const stopped = { ...ROW, package: "beta", pid: null, state: "stopped", why: "it was killed" };
    const { calls, supervisor } = runtime(() => ({ ok: true, value: [ROW, stopped] }));
    const { answer } = deps({
      running: running({ supervisors: new Map([["runtime", supervisor]]) }),
    });
    askWith("list");
    takeQuestions(userData, answer, Date.now());
    expect(await replyFor()).toEqual({
      code: 0,
      text: "  beta › ping: stopped — it was killed\n  monty › ping: running (process 77)\n",
    });
    expect(calls).toEqual([["nodes.list", null]]);
  });

  it("exits 1 naming what it refused: an instance the verb did not apply to, or a package it does not have", async () => {
    const refusing = runtime((_op, args) =>
      (args as { names: string[] }).names.includes("whodunnit")
        ? { ok: false, error: "no node of whodunnit runs in Reload" }
        : { ok: true, value: { rows: [ROW], refused: [{ ...ROW, why: "it is already running" }] } },
    );
    const { answer } = deps({
      running: running({ supervisors: new Map([["runtime", refusing.supervisor]]) }),
    });
    askWith("start", ["monty"]);
    takeQuestions(userData, answer, Date.now());
    expect(await replyFor()).toEqual({
      code: 1,
      text:
        "  monty › ping: running (process 77)\n" +
        "  monty › ping: not done (--start): it is already running\n",
    });
    const other = "f".repeat(32);
    writePrivateFile(
      questionFile(userData, other),
      JSON.stringify({ command: "restart", id: other, ...ASKER, names: ["whodunnit"] }),
    );
    takeQuestions(userData, answer, Date.now());
    expect(await replyFor(other)).toEqual({
      code: 1,
      text: "Reload could not do it: no node of whodunnit runs in Reload\n",
    });
  });
});

// The old `helper status` (test_enable_switch.py): a package turned off, one held back for it,
// and a node stopped for good, one line each and never one state printed as another.
describe("reload --status and the packages", () => {
  it("says off, held back and stopped in three different words", async () => {
    fs.writeFileSync(
      path.join(userData, "shell-settings.json"),
      JSON.stringify({ packages: { unregistered: ["switched_off"] } }),
    );
    const board = new NoticeBoard({
      deliver: () => undefined,
      store: new JsonNoticeFile(path.join(userData, NOTICES_FILENAME)),
      logger: new RecordingLogger(),
    });
    board.raise({
      kind: "package-held-back",
      subject: "incomplete",
      detail: "requires switched_off, which is off",
    });
    board.raise({
      kind: "node-stopped",
      subject: "given_up_on",
      detail: "It exited with code 1 five times in ten minutes",
    });
    const { answer } = deps();
    put("status");
    takeQuestions(userData, answer, Date.now());
    const lines = (await replyFor()).text.split("\n");
    expect(lines).toContain(
      "  switched_off: off; Register it in Configuration › General to load its nodes",
    );
    expect(lines).toContain(
      "  incomplete is held back — It requires switched_off, which is off. " +
        "None of its nodes run until that changes.",
    );
    expect(lines.find((line) => line.includes("given_up_on"))).toMatch(
      /stopped .*exited with code 1 five times/,
    );
  });
});

describe("reload --kill and --start for the shell's own children", () => {
  it("kills the services child through its supervisor, starts it again, and refuses any other verb", async () => {
    const calls: string[] = [];
    const services = {
      ...child("services", 4243),
      kill: () => (calls.push("kill"), true),
      recover: () => (calls.push("recover"), calls.length < 3),
    };
    const { answer } = deps({
      running: running({ supervisors: new Map([["services", services]]) }),
    });
    const ask = async (command: string, id: string) => {
      writePrivateFile(
        questionFile(userData, id),
        JSON.stringify({ command, id, ...ASKER, names: ["services"] }),
      );
      takeQuestions(userData, answer, Date.now());
      return replyFor(id);
    };
    expect(await ask("kill", "a".repeat(32))).toEqual({
      code: 0,
      text: "  services: killed; `reload --start` starts it again\n",
    });
    expect(await ask("start", "b".repeat(32))).toEqual({
      code: 0,
      text: "  services: started again\n",
    });
    expect(await ask("start", "c".repeat(32))).toEqual({
      code: 1,
      text: "  services: not done (--start): it is not in that state\n",
    });
    expect(await ask("stop", "d".repeat(32))).toEqual({
      code: 1,
      text: "  services: not done (--stop): only --kill and --start apply to it\n",
    });
    expect(calls).toEqual(["kill", "recover", "recover"]);
  });
});
