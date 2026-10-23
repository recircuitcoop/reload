// The run-state file and `reload --quit --force` (plan 0031 group E; the old `quit --force`):
// every process the shell is answerable for, recorded with its identity, stopped by a second
// process that asks nobody, politely then forcibly, and a survivor said out loud.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import { runShell } from "../../src/shell/lifecycle";
import type { Running } from "../../src/shell/command-answers";
import {
  DEFAULT_POLITE_MS,
  forceQuit,
  identityCommand,
  identityFrom,
  identityOf,
  RUN_STATE_FILENAME,
  UncheckedIdentity,
  writeRunState,
  type RunRecord,
} from "../../src/shell/run-state";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-run-state-")));
  file = path.join(dir, RUN_STATE_FILENAME);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const records = (): RunRecord[] => JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord[];

/** A process table in memory: each pid's identity, and how each answers a signal. */
function table(entries: Record<number, { identity: string; ignores?: "SIGTERM" | "both" }>) {
  const alive = new Map(Object.entries(entries).map(([pid, entry]) => [Number(pid), entry]));
  const signals: string[] = [];
  const printed: string[] = [];
  let clock = 0;
  const run = () =>
    forceQuit({
      file,
      identity: (pid) => alive.get(pid)?.identity ?? null,
      signal: (pid, signal) => {
        signals.push(`${String(pid)} ${signal}`);
        const entry = alive.get(pid);
        if (entry === undefined) return;
        if (entry.ignores === "both" || (entry.ignores === "SIGTERM" && signal === "SIGTERM")) {
          return;
        }
        alive.delete(pid);
      },
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
      },
      print: (text) => printed.push(text),

      lockHeld: () => false,
    });
  return { run, signals, printed };
}

const write = (list: RunRecord[]) => {
  fs.writeFileSync(file, JSON.stringify(list), { mode: 0o600 });
};

describe("reload --quit --force", () => {
  it("stops the shell first, then each child itself, politely then forcibly, and says so", () => {
    write([
      { id: "shell", pid: 10, identity: "t0 Reload" },
      { id: "runtime", pid: 11, identity: "t1 Reload runtime" },
      { id: "services", pid: 12, identity: "t2 Reload services" },
    ]);
    const { run, signals, printed } = table({
      10: { identity: "t0 Reload" },
      11: { identity: "t1 Reload runtime", ignores: "SIGTERM" },
      12: { identity: "t2 Reload services" },
    });
    expect(run()).toBe(0);
    expect(signals).toEqual(["10 SIGTERM", "11 SIGTERM", "11 SIGKILL", "12 SIGTERM"]);
    expect(printed.join("")).toBe(
      "  shell terminated (process 10)\n" +
        "  runtime killed (process 11)\n" +
        "  services terminated (process 12)\n" +
        "Reload is off.\n",
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it("says out loud what is still running after a forced kill, and keeps its record", () => {
    const list = [
      { id: "shell", pid: 10, identity: "t0 Reload" },
      { id: "runtime", pid: 11, identity: "t1 Reload runtime" },
    ];
    write(list);
    const { run, printed } = table({
      10: { identity: "t0 Reload" },
      11: { identity: "t1 Reload runtime", ignores: "both" },
    });
    expect(run()).toBe(0);
    expect(printed.join("")).toBe(
      "  shell terminated (process 10)\n" +
        "runtime (process 11) is STILL RUNNING after a forced kill.\n",
    );
    expect(records()).toEqual(list);
  });

  it("never signals a pid that now belongs to another program, or one already gone", () => {
    write([
      { id: "shell", pid: 10, identity: "t0 Reload" },
      { id: "anytype", pid: 13, identity: "t3 Anytype" },
    ]);
    const { run, signals, printed } = table({ 13: { identity: "t9 somebody's editor" } });
    expect(run()).toBe(0);
    expect(signals).toEqual([]);
    expect(printed.join("")).toBe(
      "  shell already stopped (process 10)\n" +
        "  anytype forgotten (process 13)\n" +
        "Reload is off.\n",
    );
  });

  it("says Reload is not running, and exits 1, when nothing was recorded", () => {
    const { run, printed } = table({});
    expect(run()).toBe(1);
    expect(printed).toEqual(["Reload is not running.\n"]);
  });

  it("removes a file it cannot read once nothing it names runs and no Reload holds the lock", () => {
    fs.writeFileSync(file, "{ torn");
    const { run, signals, printed } = table({});
    expect(run()).toBe(0);
    expect(signals).toEqual([]);
    expect(printed.join("")).toMatch(
      new RegExp(
        "^The run-state file could not be read: SyntaxError.*\\n" +
          `It is ${file.replaceAll("/", "\\/")}\\. Nothing it names runs, so it was removed\\. ` +
          "Reload is off\\.\\n$",
      ),
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps a file it cannot read while a process it names runs, or a Reload holds the lock", () => {
    // Unreadable by an unknown field, and still naming a live process: left as it is.
    write([{ id: "runtime", pid: 11, identity: "t1 Reload runtime", extra: 1 } as RunRecord]);
    const { run, signals, printed } = table({ 11: { identity: "t1 Reload runtime" } });
    expect(run()).toBe(1);
    expect(signals).toEqual([]);
    expect(printed.join("")).toBe(
      "The run-state file could not be read: record 1 has an unknown field, extra.\n" +
        `It is ${file}. It still names runtime (process 11), which still runs, so it is left ` +
        "as it is: quit Reload from its window.\n",
    );
    fs.writeFileSync(file, "{ torn");
    const held = forceQuit({
      file,
      identity: () => null,
      signal: () => undefined,
      now: () => 0,
      sleep: () => undefined,
      print: (text) => printed.push(text),
      lockHeld: () => true,
    });
    expect(held).toBe(1);
    expect(printed.at(-1)).toContain("A Reload holds its lock, so it is left as it is");
    expect(fs.existsSync(file)).toBe(true);
  });

  it(
    "stops a real process found by its identity in the process table",
    async () => {
      const sleeper = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        stdio: "ignore",
      });
      const pid = sleeper.pid ?? 0;
      const exited = new Promise((resolve) => sleeper.once("exit", resolve));
      await writeRunState(file, [{ id: "runtime", pid }], process.platform);
      const [record] = records();
      expect(record?.identity).toBe(identityOf(pid, process.platform));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const printed: string[] = [];
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      const code = forceQuit({
        file,
        identity: (id) => identityOf(id, process.platform),
        signal: (id, signal) => process.kill(id, signal),
        now: Date.now,
        sleep: (ms) => Atomics.wait(waiter, 0, 0, ms),
        print: (text) => printed.push(text),

        lockHeld: () => false,
      });
      await exited;
      expect(code).toBe(0);
      expect(printed.join("")).toBe(
        `  runtime terminated (process ${String(pid)})\nReload is off.\n`,
      );
      expect(identityOf(pid, process.platform)).toBeNull();
    },
    DEFAULT_POLITE_MS * 2,
  );

  it("reads a malformed file as unreadable, names the field that is wrong, and signals nothing", () => {
    const { run, signals, printed } = table({ 10: { identity: "t0 Reload" } });
    const shell = '{"id":"shell","pid":10,"identity":"t0 Reload"}';
    const malformed: [string, string][] = [
      [shell, "it is not a list of the processes Reload ran"],
      ['[{"id":"shell","identity":"t0 Reload"}]', "record 1 has no valid pid"],
      ['[{"id":"shell","pid":"4242","identity":"t0 Reload"}]', "record 1 has no valid pid"],
      [
        `[${shell},{"id":"runtime","pid":"10; Stop-Computer","identity":"t1"}]`,
        "record 2 has no valid pid",
      ],
      ['[{"id":"shell","pid":-1,"identity":"t0 Reload"}]', "record 1 has no valid pid"],
      ['[{"id":"shell","pid":10.5,"identity":"t0 Reload"}]', "record 1 has no valid pid"],
      ['[{"id":"shell","pid":10,"identity":""}]', "record 1 has no valid identity"],
      ['[{"pid":10,"identity":"t0 Reload"}]', "record 1 has no valid id"],
      [
        '[{"id":"\\u001b]0;owned\\u0007","pid":10,"identity":"t0 Reload"}]',
        "record 1 has no valid id",
      ],
      ["[null]", "record 1 is not a record"],
      ['[{"id":"shell","pid":10,"identity":"t0","\\u001b[2J":1}]', "record 1 has an unknown field"],
    ];
    for (const [text] of malformed) {
      fs.writeFileSync(file, text);
      run();
    }
    expect(signals).toEqual([]);
    expect(printed.map((text) => text.split("\n")[0])).toEqual(
      malformed.map(([, why]) => `The run-state file could not be read: ${why}.`),
    );
  });

  /** What `--quit --force` says of a run-state file holding just this record. */
  const refusal = (record: string) => {
    fs.writeFileSync(file, `[${record}]`);
    const { run, signals, printed } = table({ 1: { identity: "t0 Reload" } });
    run();
    expect(signals).toEqual([]);
    return `${printed.join("").split("\n")[0] ?? ""}\n`;
  };

  it("refuses a record whose pid is not a number, by naming the pid", () => {
    expect(refusal('{"id":"alpha","pid":"4242","identity":"t0 Reload"}')).toBe(
      "The run-state file could not be read: record 1 has no valid pid.\n",
    );
  });

  it("refuses a record with a start time of its own, by naming the field", () => {
    expect(refusal('{"id":"alpha","pid":1,"identity":"t0 Reload","started_at":"noon"}')).toBe(
      "The run-state file could not be read: record 1 has an unknown field, started_at.\n",
    );
  });

  it("refuses a record with a parent pid, by naming the field", () => {
    expect(
      refusal(
        '{"id":"alpha","pid":1,"identity":"t0 Reload","executable":"/bin/sh","parent_pid":true}',
      ),
    ).toBe("The run-state file could not be read: record 1 has an unknown field, executable.\n");
    expect(refusal('{"id":"alpha","pid":1,"identity":"t0 Reload","parent_pid":true}')).toBe(
      "The run-state file could not be read: record 1 has an unknown field, parent_pid.\n",
    );
  });

  it("refuses a record missing a field, by naming the field", () => {
    expect(refusal('{"id":"alpha","pid":1}')).toBe(
      "The run-state file could not be read: record 1 has no valid identity.\n",
    );
  });

  it("reads a process as gone only from no line and the kernel knowing no such pid", () => {
    const failed = Object.assign(new Error("Command failed: /bin/ps"), { status: 1 });
    // macOS ps exits 1 for an error too: with the process there, that is not "gone".
    expect(() => identityFrom(42, failed, "", () => true)).toThrow(UncheckedIdentity);
    expect(() => identityFrom(42, null, "", () => true)).toThrow(UncheckedIdentity);
    expect(identityFrom(42, failed, "", () => false)).toBeNull();
    expect(identityFrom(42, null, "  t0 Reload \n", () => true)).toBe("t0 Reload");
    expect(() => identityFrom(42, failed, "t0 Reload", () => true)).toThrow(UncheckedIdentity);
  });

  it("prints no control character, whatever a reason carried", () => {
    write([{ id: "runtime", pid: 11, identity: "t1 Reload runtime" }]);
    const printed: string[] = [];
    forceQuit({
      file,
      identity: () => {
        throw new UncheckedIdentity("the process table could not be read: \u001b]0;owned\u0007");
      },
      signal: () => undefined,
      now: () => 0,
      sleep: () => undefined,
      print: (text) => printed.push(text),

      lockHeld: () => false,
    });
    expect(printed.join("")).toBe(
      "runtime (process 11) could not be checked: the process table could not be read: ]0;owned.\n",
    );
  });

  it("never takes a process table it could not read for a process that is gone", () => {
    write([
      { id: "shell", pid: 10, identity: "t0 Reload" },
      { id: "runtime", pid: 11, identity: "t1 Reload runtime" },
    ]);
    const printed: string[] = [];
    const signals: string[] = [];
    let clock = 0;
    const code = forceQuit({
      file,
      identity: (pid) => {
        if (pid === 11) throw new UncheckedIdentity("the process table could not be read: ENOENT");
        return null;
      },
      signal: (pid, signal) => signals.push(`${String(pid)} ${signal}`),
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
      },
      print: (text) => printed.push(text),

      lockHeld: () => false,
    });
    expect(code).toBe(1);
    expect(signals).toEqual([]);
    expect(printed.join("")).toBe(
      "  shell already stopped (process 10)\n" +
        "runtime (process 11) could not be checked: the process table could not be read: ENOENT.\n",
    );
    expect(fs.existsSync(file)).toBe(true);
  });

  it("says it could not read the process table when the program that reads it is missing", () => {
    // No powershell.exe on this machine: the same as a missing /bin/ps, or one that timed out.
    if (process.platform === "win32") return;
    expect(() => identityOf(process.pid, "win32")).toThrow(UncheckedIdentity);
  });

  it(
    "reads the same identity whatever the locale and the time zone of the reader",
    async () => {
      const sleeper = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        stdio: "ignore",
      });
      const pid = sleeper.pid ?? 0;
      const kept = {
        LANG: process.env["LANG"],
        LC_ALL: process.env["LC_ALL"],
        TZ: process.env["TZ"],
      };
      const as = (env: { LANG: string; TZ: string }) => {
        process.env["LANG"] = env.LANG;
        process.env["LC_ALL"] = env.LANG;
        process.env["TZ"] = env.TZ;
      };
      try {
        // Recorded by an app started from the Dock, checked from a terminal in another country.
        as({ LANG: "", TZ: "Pacific/Kiritimati" });
        await writeRunState(file, [{ id: "runtime", pid }], process.platform);
        as({ LANG: "de_DE.UTF-8", TZ: "America/New_York" });
        expect(identityOf(pid, process.platform)).toBe(records()[0]?.identity);
        as({ LANG: "en_GB.UTF-8", TZ: "Asia/Tokyo" });
        expect(identityOf(pid, process.platform)).toBe(records()[0]?.identity);
      } finally {
        for (const [name, value] of Object.entries(kept)) {
          if (value === undefined) Reflect.deleteProperty(process.env, name);
          else process.env[name] = value;
        }
        sleeper.kill("SIGKILL");
      }
    },
    DEFAULT_POLITE_MS * 2,
  );

  it("gives a record named like an object's own property the default polite wait, which ends", () => {
    write([{ id: "constructor", pid: 14, identity: "t4 Reload node" }]);
    const { run, signals, printed } = table({
      14: { identity: "t4 Reload node", ignores: "SIGTERM" },
    });
    expect(run()).toBe(0);
    expect(signals).toEqual(["14 SIGTERM", "14 SIGKILL"]);
    expect(printed.join("")).toBe("  constructor killed (process 14)\nReload is off.\n");
  });

  it("puts only a positive integer on the process table's command line", () => {
    expect(identityCommand(4242, "win32")[1].join(" ")).toContain('"ProcessId=4242"');
    expect(identityCommand(4242, "darwin")).toEqual([
      "/bin/ps",
      ["-o", "lstart=,args=", "-p", "4242"],
      { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    ]);
    for (const pid of [0, -1, 1.5, Number.NaN, "1; Stop-Computer" as unknown as number]) {
      expect(() => identityCommand(pid, "win32")).toThrow(RangeError);
    }
  });

  it("writes a regular file only this user can read, whatever stood at either name", async () => {
    // A scratch file a crash left as a link, and the file itself a link: neither is followed.
    const elsewhere = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(elsewhere, "kept", { mode: 0o644 });
    fs.symlinkSync(elsewhere, `${file}.tmp`);
    fs.symlinkSync(elsewhere, file);
    await writeRunState(file, [{ id: "shell", pid: process.pid }], process.platform);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(records().map((record) => record.id)).toEqual(["shell"]);
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("kept");
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    // One written before with a wider mode is replaced by one with this mode.
    fs.rmSync(file);
    fs.writeFileSync(file, "[]", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await writeRunState(file, [{ id: "shell", pid: process.pid }], process.platform);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves out of the record a process that is already gone", async () => {
    const quick = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => quick.once("exit", resolve));
    await writeRunState(file, [{ id: "runtime", pid: quick.pid ?? 0 }], process.platform);
    expect(records()).toEqual([]);
  });
});

describe("the shell's run-state", () => {
  /** A shell whose runtime and Anytype report through `changed` and `anytypeStarted`. */
  function shell(userData = dir) {
    const app = Object.assign(new EventEmitter(), {
      requestSingleInstanceLock: () => true,
      exit: () => undefined,
      isReady: () => true,
      quit: () => undefined,
      getPath: () => userData,
      getVersion: () => "1.2.3",
    });
    const listeners: ((status: ChildStatus) => void)[] = [];
    const started: (() => void)[] = [];
    const pids = { runtime: null as number | null, anytype: null as number | null };
    const notifier = new RecordingNotifier();
    const anytype: Running["anytype"] = {
      state: null,
      get startedPid() {
        return pids.anytype;
      },
      onStarted: (listener) => started.push(listener),
    };
    runShell({
      app: app as never,
      signals: new EventEmitter() as never,
      quitFlow: { done: false, request: () => Promise.resolve("quit") },
      bringForward: () => undefined,
      windowOpen: () => true,
      running: {
        supervisors: new Map([
          [
            "runtime",
            {
              status: () => ({ child: "runtime", pid: pids.runtime }) as ChildStatus,
              onStatus: (listener: (status: ChildStatus) => void) => {
                listeners.push(listener);
              },
            },
          ],
        ]),
        anytype,
        notices: "notices.json",
      },
      start: () => Promise.resolve(notifier),
      logger: new RecordingLogger(),
    });
    const changed = () => {
      for (const listener of listeners) listener({ child: "runtime" } as ChildStatus);
    };
    const anytypeStarted = () => {
      for (const listener of started) listener();
    };
    return { app, pids, changed, anytypeStarted, notifier };
  }

  it("records an Anytype Reload starts after the children's last change, when it starts", async () => {
    const { pids, anytypeStarted } = shell();
    await expect.poll(() => fs.existsSync(file)).toBe(true);
    pids.anytype = process.pid;
    anytypeStarted();
    await expect.poll(() => records().map((record) => record.id)).toEqual(["shell", "anytype"]);
  });

  it("is a notice once when it cannot be written, however often it fails, and cleared once it is", async () => {
    const missing = path.join(dir, "not-yet");
    const { changed, notifier } = shell(missing);
    // Its folder is missing, so the questions' folder cannot be read either: told apart.
    const ours = () => notifier.notices.filter((notice) => notice.subject === "run-state file");
    await expect.poll(() => ours().length).toBe(1);
    for (let n = 0; n < 5; n += 1) changed();
    // Every write after the first fails the same way, and tells nobody anything new.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ours()).toEqual([
      {
        kind: "command-line-unwritable",
        subject: "run-state file",
        detail: expect.stringContaining("ENOENT") as unknown,
      },
    ]);
    fs.mkdirSync(missing);
    changed();
    await expect
      .poll(() => notifier.cleared, { timeout: 10_000 })
      .toContain("command-line-unwritable run-state file");
    expect(fs.existsSync(path.join(missing, RUN_STATE_FILENAME))).toBe(true);
  });

  it("is written once the children are supervised, again on a change, and removed at quit", async () => {
    const { app, pids, changed } = shell();
    await expect.poll(() => fs.existsSync(file)).toBe(true);
    expect(records().map((record) => [record.id, record.pid])).toEqual([["shell", process.pid]]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The runtime reported its process: recorded beside the shell.
    pids.runtime = process.pid;
    changed();
    await expect.poll(() => records().map((record) => record.id)).toEqual(["shell", "runtime"]);
    app.emit("quit");
    expect(fs.existsSync(file)).toBe(false);
  });
});
