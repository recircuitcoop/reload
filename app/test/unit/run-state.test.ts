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
import {
  DEFAULT_POLITE_MS,
  forceQuit,
  identityOf,
  RUN_STATE_FILENAME,
  writeRunState,
  type RunRecord,
} from "../../src/shell/run-state";
import { RecordingLogger } from "../fakes/children";

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

  it("leaves out of the record a process that is already gone", async () => {
    const quick = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => quick.once("exit", resolve));
    await writeRunState(file, [{ id: "runtime", pid: quick.pid ?? 0 }], process.platform);
    expect(records()).toEqual([]);
  });
});

describe("the shell's run-state", () => {
  it("is written once the children are supervised, again on a change, and removed at quit", async () => {
    const app = Object.assign(new EventEmitter(), {
      requestSingleInstanceLock: () => true,
      exit: () => undefined,
      isReady: () => true,
      quit: () => undefined,
      getPath: () => dir,
      getVersion: () => "1.2.3",
    });
    const listeners: ((status: ChildStatus) => void)[] = [];
    let runtimePid: number | null = null;
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
              status: () => ({ child: "runtime", pid: runtimePid }) as ChildStatus,
              onStatus: (listener: (status: ChildStatus) => void) => {
                listeners.push(listener);
              },
            },
          ],
        ]),
        anytype: { state: "adopted", startedPid: null },
        log: null,
        notices: "notices.json",
      },
      start: () => Promise.resolve(),
      logger: new RecordingLogger(),
    });
    await expect.poll(() => fs.existsSync(file)).toBe(true);
    expect(records().map((record) => [record.id, record.pid])).toEqual([["shell", process.pid]]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The runtime reported its process: recorded beside the shell.
    runtimePid = process.pid;
    for (const listener of listeners)
      listener({ child: "runtime", pid: runtimePid } as ChildStatus);
    await expect.poll(() => records().map((record) => record.id)).toEqual(["shell", "runtime"]);
    app.emit("quit");
    expect(fs.existsSync(file)).toBe(false);
  });
});
