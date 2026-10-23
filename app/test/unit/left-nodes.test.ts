// application/left-nodes.ts: the node processes a crashed runtime left behind are stopped,
// politely and then forcibly, before the next runtime starts (the old helper's orphans,
// tests/test_helper_process_identity.py), and the runtime records each one it starts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { JsonNodeRecords, NODE_RECORDS_FILENAME } from "../../src/adapters/process/node-records";

import {
  recordingWatchdog,
  runtimeWatchdog,
  stopLeftNodes,
} from "../../src/application/left-nodes";
import type {
  NodeRecord,
  NodeRecordStore,
  ProcessIdentity,
  ProcessReading,
  ResourceProbe,
  WatchedProcess,
} from "../../src/ports/resource-watch";
import { DEFAULT_LIMITS } from "../../src/domain/supervision/resources";
import { FakeClock } from "../fakes/clock";
import { obedient, RecordingLogger, type Behaviour } from "../fakes/children";
import { supervised } from "../fakes/supervised";

const identity = (pid: number): ProcessIdentity => ({
  started: `Fri Oct 23 10:00:0${String(pid % 10)} 2026`,
  executable: "/usr/bin/python3",
});
const record = (pid: number): NodeRecord => ({ pid, identity: identity(pid) });

class MemoryRecords implements NodeRecordStore {
  records: readonly NodeRecord[];
  constructor(records: readonly NodeRecord[] = []) {
    this.records = records;
  }
  read(): readonly NodeRecord[] {
    return this.records;
  }
  write(records: readonly NodeRecord[]): void {
    this.records = records;
  }
}

/** A process table: who runs now, and how each answers a signal to its group. */
function machine() {
  const running = new Map<number, ProcessIdentity>();
  const stubborn = new Set<number>(); // ignores SIGTERM
  const unkillable = new Set<number>(); // survives SIGKILL too
  const events: string[] = [];
  const reading = (who: ProcessIdentity): ProcessReading => ({
    identity: who,
    sample: { memoryMb: 1, cpuSeconds: 0, openFiles: 1, children: 0 },
    strays: [],
  });
  const probe: ResourceProbe = (pids) =>
    Promise.resolve(
      new Map(
        pids.flatMap((pid) => {
          const who = running.get(pid);
          return who === undefined ? [] : [[pid, reading(who)] as const];
        }),
      ),
    );
  const signal = (target: number, name: "SIGTERM" | "SIGKILL"): void => {
    events.push(`${name} ${String(target)}`);
    const pid = -target;
    if (name === "SIGTERM" ? !stubborn.has(pid) : !unkillable.has(pid)) {
      running.delete(pid);
    }
  };
  return { running, stubborn, unkillable, events, probe, signal };
}

/** Let the stop run to its end, moving the fake clock through its waits. */
async function drive(clock: FakeClock, done: () => boolean): Promise<void> {
  for (let step = 0; step < 500 && !done(); step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(100);
  }
  expect(done()).toBe(true);
}

describe("node processes a crashed runtime left behind", () => {
  it("an orphan is asked politely before it is killed, and its record is gone after", async () => {
    const m = machine();
    m.running.set(501, identity(501));
    m.stubborn.add(501);
    const store = new MemoryRecords([record(501)]);
    const clock = new FakeClock();
    let finished = false;
    void stopLeftNodes({ ...m, store, clock, logger: new RecordingLogger() }).then(() => {
      finished = true;
    });
    await drive(clock, () => finished);
    expect(m.events).toEqual(["SIGTERM -501", "SIGKILL -501"]);
    expect(m.running.has(501)).toBe(false);
    expect(store.records).toEqual([]);
  });

  it("one that goes when asked is never killed", async () => {
    const m = machine();
    m.running.set(502, identity(502));
    const store = new MemoryRecords([record(502)]);
    const clock = new FakeClock();
    let finished = false;
    void stopLeftNodes({ ...m, store, clock, logger: new RecordingLogger() }).then(() => {
      finished = true;
    });
    await drive(clock, () => finished);
    expect(m.events).toEqual(["SIGTERM -502"]);
  });

  it("every orphan is stopped before the runtime is started again, and a reused pid is never signalled", async () => {
    const m = machine();
    m.running.set(501, identity(501)); // stubborn
    m.running.set(502, identity(502)); // goes when asked
    m.running.set(503, { started: "Fri Oct 23 16:00:00 2026", executable: "/bin/zsh" }); // reused
    m.stubborn.add(501);
    const store = new MemoryRecords([record(501), record(502), record(503), record(504)]);
    const forked: Behaviour = {
      ...obedient,
      onFork: (child, at) => {
        m.events.push("fork");
        obedient.onFork?.(child, at);
      },
    };
    const { supervisor, launcher, clock } = supervised(forked, {
      beforeFork: () => stopLeftNodes({ ...m, store, clock, logger: new RecordingLogger() }),
    });
    supervisor.start();
    await drive(clock, () => launcher.children.length === 1);
    expect(m.events).toEqual(["SIGTERM -501", "SIGTERM -502", "SIGKILL -501", "fork"]);
    expect(m.running.has(503)).toBe(true);
    expect(store.records).toEqual([]);
  });

  it("a process that survives its kill keeps its record, and is said in the log", async () => {
    const m = machine();
    m.running.set(501, identity(501));
    m.stubborn.add(501);
    m.unkillable.add(501);
    const store = new MemoryRecords([record(501)]);
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    let finished = false;
    void stopLeftNodes({ ...m, store, clock, logger }).then(() => {
      finished = true;
    });
    await drive(clock, () => finished);
    expect(m.events).toEqual(["SIGTERM -501", "SIGKILL -501"]);
    expect(store.records).toEqual([record(501)]);
    expect(logger.lines).toContain("ERROR node process 501 is still running after a forced kill");
  });

  it("with nothing recorded, reads nothing and signals nothing", async () => {
    const m = machine();
    let read = false;
    const probe: ResourceProbe = (pids) => {
      read = true;
      return m.probe(pids);
    };
    const clock = new FakeClock();
    await stopLeftNodes({
      ...m,
      probe,
      store: new MemoryRecords(),
      clock,
      logger: new RecordingLogger(),
    });
    expect(read).toBe(false);
    expect(m.events).toEqual([]);
  });

  it("signals nothing, and keeps every record, when the process table cannot be read", async () => {
    const m = machine();
    const store = new MemoryRecords([record(501)]);
    const broken: ResourceProbe = () => Promise.reject(new Error("ps did not answer"));
    await expect(
      stopLeftNodes({
        ...m,
        probe: broken,
        store,
        clock: new FakeClock(),
        logger: new RecordingLogger(),
      }),
    ).rejects.toThrow("ps did not answer");
    expect(m.events).toEqual([]);
    expect(store.records).toEqual([record(501)]);
  });
});

describe("the runtime's record of its node processes", () => {
  const target = (pid: number, current = () => true): WatchedProcess => ({
    pid,
    limits: DEFAULT_LIMITS,
    stop: () => undefined,
    kill: () => undefined,
    current,
    stopped: () => undefined,
  });
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("records each process with its identity while it is watched, and forgets it after", async () => {
    const m = machine();
    m.running.set(601, identity(601));
    m.running.set(602, identity(602));
    const store = new MemoryRecords();
    const handed: number[] = [];
    let cancelled = 0;
    const watchdog = recordingWatchdog(
      (watched) => {
        handed.push(watched.pid);
        return () => (cancelled += 1);
      },
      { probe: m.probe, store, log: () => undefined },
    );
    const first = watchdog(target(601));
    watchdog(target(602));
    await flush();
    expect(handed).toEqual([601, 602]);
    expect(store.records).toEqual([record(601), record(602)]);
    first();
    expect(cancelled).toBe(1);
    expect(store.records).toEqual([record(602)]);
  });

  it("is the runtime's own watchdog: a process handed to it is watched and recorded", async () => {
    const m = machine();
    m.running.set(601, identity(601));
    const store = new MemoryRecords();
    const watchdog = runtimeWatchdog({
      probe: m.probe,
      store,
      clock: new FakeClock(),
      log: () => undefined,
      signal: m.signal,
    });
    const cancel = watchdog(target(601));
    await flush();
    expect(store.records).toEqual([record(601)]);
    cancel();
    expect(store.records).toEqual([]);
  });

  it("keeps what the shell could not stop, and records no process already gone or replaced", async () => {
    const m = machine();
    m.running.set(702, identity(702));
    const store = new MemoryRecords([record(501)]);
    const watchdog = recordingWatchdog(() => () => undefined, {
      probe: m.probe,
      store,
      log: () => undefined,
    });
    watchdog(target(701)); // exited before it was read
    watchdog(target(702, () => false)); // replaced before it was read
    const third = watchdog(target(702));
    third(); // its watch ended before it was read
    await flush();
    expect(store.records).toEqual([record(501)]);
  });
});

describe("the record file", () => {
  const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "reload-records-"));

  it("is none when there is no file, and a list written whole, readable by its owner alone", () => {
    const dir = scratch();
    const store = new JsonNodeRecords(dir);
    expect(store.read()).toEqual([]);
    store.write([record(501), { pid: 502, identity: { started: "x", executable: null } }]);
    expect(store.read()).toEqual([
      record(501),
      { pid: 502, identity: { started: "x", executable: null } },
    ]);
    expect(fs.statSync(path.join(dir, NODE_RECORDS_FILENAME)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([NODE_RECORDS_FILENAME]);
  });

  it("is read as untrusted: what is not a record is left out, and never signalled", () => {
    const dir = scratch();
    const file = path.join(dir, NODE_RECORDS_FILENAME);
    const good = record(501);
    fs.writeFileSync(
      file,
      JSON.stringify([
        good,
        null,
        "501",
        { pid: -1, identity: good.identity },
        { pid: 0, identity: good.identity },
        { pid: 1.5, identity: good.identity },
        { pid: "501", identity: good.identity },
        { pid: 503 },
        { pid: 504, identity: { started: "", executable: null } },
        { pid: 505, identity: { started: "x", executable: 7 } },
      ]),
    );
    expect(new JsonNodeRecords(dir).read()).toEqual([good]);
    fs.writeFileSync(file, '{"pid": 501}');
    expect(new JsonNodeRecords(dir).read()).toEqual([]);
    fs.writeFileSync(file, "not json");
    expect(new JsonNodeRecords(dir).read()).toEqual([]);
  });

  it("leaves the records before it, and no scratch file, when a write fails", () => {
    const dir = scratch();
    const store = new JsonNodeRecords(dir);
    store.write([record(501)]);
    // A directory where the file belongs: the rename fails.
    const blocked = new JsonNodeRecords(path.join(dir, "nowhere"));
    expect(() => {
      blocked.write([record(502)]);
    }).toThrow();
    fs.mkdirSync(path.join(dir, "nowhere", NODE_RECORDS_FILENAME), { recursive: true });
    expect(() => {
      blocked.write([record(502)]);
    }).toThrow();
    expect(fs.readdirSync(path.join(dir, "nowhere"))).toEqual([NODE_RECORDS_FILENAME]);
    expect(store.read()).toEqual([record(501)]);
  });

  it("is said in the runtime's log when it cannot be written, and the watch goes on", async () => {
    const m = machine();
    m.running.set(601, identity(601));
    const lines: string[] = [];
    let handed = 0;
    const watchdog = recordingWatchdog(
      () => {
        handed += 1;
        return () => undefined;
      },
      {
        probe: m.probe,
        store: new JsonNodeRecords(path.join(scratch(), "nowhere")),
        log: (level, message) => lines.push(`${level} ${message}`),
      },
    );
    watchdog({
      pid: 601,
      limits: DEFAULT_LIMITS,
      stop: () => undefined,
      kill: () => undefined,
      current: () => true,
      stopped: () => undefined,
    });
    const broken = recordingWatchdog(() => () => undefined, {
      probe: () => Promise.reject(new Error("ps did not answer")),
      store: new MemoryRecords(),
      log: (level, message) => lines.push(`${level} ${message}`),
    });
    broken({
      pid: 602,
      limits: DEFAULT_LIMITS,
      stop: () => undefined,
      kill: () => undefined,
      current: () => true,
      stopped: () => undefined,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(handed).toBe(1);
    expect(lines[0]).toMatch(/^error the node processes could not be recorded: /);
    expect(lines[1]).toBe("warn node process 602 not recorded: Error: ps did not answer");
  });
});
