// A node instance's side of the resource watchdog (adapters/process/resource-guard.ts): what it
// hands the watchdog, how it stops a process, and when the person is told.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NODE_PROCESS,
  type NodeProcessDeps,
} from "../../src/adapters/process/node-process";
import type { ProcessTree } from "../../src/adapters/process/process-tree";
import { NodeResourceGuard } from "../../src/adapters/process/resource-guard";
import { DEFAULT_LIMITS } from "../../src/domain/supervision/resources";
import type { NodeProcessSpec } from "../../src/ports/node-process";
import type { WatchedProcess } from "../../src/ports/resource-watch";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import { RecordingLogger, RecordingNotifier, rawNodeSpec } from "../fixtures/raw-node/fixture";

function harness(watched = true) {
  const notifier = new RecordingNotifier();
  const signals: string[] = [];
  const handed: WatchedProcess[] = [];
  let cancelled = 0;
  const tree: ProcessTree = {
    detached: true,
    blocked: null,
    kill: (pid) => signals.push(`SIGKILL ${String(pid)}`),
    stop: (pid) => signals.push(`SIGTERM ${String(pid)}`),
    sweep: () => Promise.resolve(),
  };
  const deps: NodeProcessDeps = {
    clock: new FakeClock(),
    logger: new RecordingLogger(),
    notifier,
    tree,
    newId: () => "id",
    secrets: { protect: () => undefined },
    journal: new MemoryJournal(),
    settings: DEFAULT_NODE_PROCESS,
    ...(watched
      ? {
          watchdog: (target: WatchedProcess) => {
            handed.push(target);
            return () => {
              cancelled += 1;
            };
          },
        }
      : {}),
  };
  return { notifier, signals, handed, deps, cancelled: () => cancelled };
}

function spec(id: string, name = "", limits?: NodeProcessSpec["limits"]): NodeProcessSpec {
  const base = rawNodeSpec();
  return {
    ...base,
    identity: { ...base.identity, id, name },
    ...(limits === undefined ? {} : { limits }),
  };
}

describe("a node instance's resource guard", () => {
  it("hands each process to the watchdog with its type's limits, and stops it by its group", () => {
    const h = harness();
    const limits = { ...DEFAULT_LIMITS, memoryMb: 2048 };
    const guard = new NodeResourceGuard(spec("n1", "", limits), h.deps);
    guard.watch(4242, () => true);
    const [target] = h.handed;
    expect(target?.pid).toBe(4242);
    expect(target?.limits).toEqual(limits);
    expect(target?.current()).toBe(true);
    target?.stop();
    target?.kill();
    expect(h.signals).toEqual(["SIGTERM 4242", "SIGKILL 4242"]);
    const cancel = guard.watch(4343, () => true);
    cancel();
    expect(h.cancelled()).toBe(1);
  });

  it("is watched under the documented limits when its spec names none", () => {
    const h = harness();
    new NodeResourceGuard(spec("n1"), h.deps).watch(4242, () => true);
    expect(h.handed[0]?.limits).toEqual(DEFAULT_LIMITS);
  });

  it("tells the person it started the node again only once the next process has started", () => {
    const h = harness();
    const guard = new NodeResourceGuard(spec("n1", "Summarize"), h.deps);
    guard.watch(4242, () => true);
    h.handed[0]?.stopped("memory 2048 MB, over its limit of 1024 MB, for 70 s");
    expect(h.notifier.notices).toEqual([]);
    guard.watch(4343, () => true);
    expect(h.notifier.notices).toEqual([
      {
        kind: "node-over-limit",
        subject: "n1",
        detail:
          'The node "Summarize" (raw) used memory 2048 MB, over its limit of 1024 MB, for 70 s, ' +
          "so Reload stopped it and started it again",
      },
    ]);
    guard.watch(4444, () => true);
    expect(h.notifier.notices).toHaveLength(1);
  });

  it("tells two unnamed nodes of one type apart, by their instance ids", () => {
    const h = harness();
    for (const id of ["n1", "n2"]) {
      const guard = new NodeResourceGuard(spec(id), h.deps);
      guard.watch(1, () => true);
      h.handed.at(-1)?.stopped("CPU 150 %, over its limit of 90 %, for 61 s");
      guard.watch(2, () => true);
    }
    expect(h.notifier.notices.map((notice) => notice.subject)).toEqual(["n1", "n2"]);
    expect(h.notifier.notices[0]?.detail).toMatch(/^The node raw used CPU 150 %/);
  });

  it("tells one episode once, and ends the instance at the fifth stop in ten minutes", () => {
    const h = harness();
    const guard = new NodeResourceGuard(spec("n1", "Summarize"), h.deps);
    const clock = h.deps.clock as FakeClock;
    for (let stop = 1; stop <= 5; stop += 1) {
      guard.watch(1000 + stop, () => true);
      expect(guard.restartable).toBe(true);
      h.handed
        .at(-1)
        ?.stopped(`memory ${String(2000 + stop)} MB, over its limit of 1024 MB, for 61 s`);
      clock.advance(80_000);
    }
    expect(guard.restartable).toBe(false);
    expect(guard.stopText({ maxCrashes: 5, windowMs: 120_000 })).toBe(
      "stopped after going over its resource limits 5 times in 10 minutes " +
        "(the last: memory 2005 MB, over its limit of 1024 MB, for 61 s)",
    );
    // The four restarts were one episode: told once, with the numbers of its first stop.
    expect(h.notifier.notices).toHaveLength(1);
    expect(h.notifier.notices[0]?.detail).toContain("memory 2001 MB");
  });

  it("starts a new episode once the ten minutes have passed", () => {
    const h = harness();
    const guard = new NodeResourceGuard(spec("n1"), h.deps);
    const clock = h.deps.clock as FakeClock;
    guard.watch(1, () => true);
    h.handed.at(-1)?.stopped("memory 2001 MB, over its limit of 1024 MB, for 61 s");
    guard.watch(2, () => true);
    clock.advance(600_001);
    h.handed.at(-1)?.stopped("memory 2002 MB, over its limit of 1024 MB, for 61 s");
    guard.watch(3, () => true);
    expect(h.notifier.notices).toHaveLength(2);
    expect(guard.restartable).toBe(true);
  });

  it("watches nothing without a watchdog or a process", () => {
    const unwatched = harness(false);
    const guard = new NodeResourceGuard(spec("n1"), unwatched.deps);
    guard.watch(4242, () => true)();
    const h = harness();
    new NodeResourceGuard(spec("n1"), h.deps).watch(undefined, () => true);
    expect(h.handed).toEqual([]);
  });
});
