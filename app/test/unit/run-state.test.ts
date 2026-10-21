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
import type { Running } from "../../src/shell/command-line";
import {
  DEFAULT_POLITE_MS,
  forceQuit,
  identityCommand,
  identityOf,
  RUN_STATE_FILENAME,
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
    fs.writeFileSync(file, "{ torn");
    expect(run()).toBe(1);
    expect(printed[1]).toContain("The run-state file could not be read");
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

  it("reads a malformed file as unreadable, says so plainly, and signals nothing", () => {
    const { run, signals, printed } = table({ 10: { identity: "t0 Reload" } });
    const malformed = [
      '{"id":"shell","pid":10,"identity":"t0 Reload"}',
      '[{"id":"shell","identity":"t0 Reload"}]',
      '[{"id":"shell","pid":"10; Stop-Computer","identity":"t0 Reload"}]',
      '[{"id":"shell","pid":-1,"identity":"t0 Reload"}]',
      '[{"id":"shell","pid":10.5,"identity":"t0 Reload"}]',
      '[{"id":"\\u001b]0;owned\\u0007","pid":10,"identity":"t0 Reload"}]',
      "[null]",
    ];
    for (const text of malformed) {
      fs.writeFileSync(file, text);
      expect(run()).toBe(1);
    }
    expect(signals).toEqual([]);
    expect(new Set(printed)).toEqual(
      new Set([
        "The run-state file could not be read: it is not a list of the processes Reload ran.\n",
      ]),
    );
  });

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
    await expect.poll(() => notifier.notices.length).toBe(1);
    for (let n = 0; n < 5; n += 1) changed();
    // Every write after the first fails the same way, and tells nobody anything new.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(notifier.notices).toEqual([
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
      .toEqual(["command-line-unwritable run-state file"]);
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
