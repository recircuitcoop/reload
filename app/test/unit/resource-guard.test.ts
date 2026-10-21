// The resource watchdog of one node process (adapters/process/resource-guard.ts), on a fake
// clock and a fake probe: what it samples, when it stops a process, and what it never does.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NODE_PROCESS,
  type NodeProcessDeps,
} from "../../src/adapters/process/node-process";
import type { ProcessTree } from "../../src/adapters/process/process-tree";
import { guardResources, type GuardHost } from "../../src/adapters/process/resource-guard";
import type { ResourceProbe } from "../../src/adapters/process/resource-probe";
import { DEFAULT_LIMITS, type ResourceSample } from "../../src/domain/supervision/resources";
import { MemoryJournal } from "../fakes/journal";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger, RecordingNotifier, rawNodeSpec } from "../fixtures/raw-node/fixture";

const QUIET: ResourceSample = { memoryMb: 100, cpuSeconds: 0, openFiles: 10, children: 0 };
const EVERY = DEFAULT_NODE_PROCESS.resources.sampleEveryMs;

/** Lets the probe's promise settle, as the event loop would between two samples. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(readings: (pid: number) => ResourceSample | null, probed = true) {
  const clock = new FakeClock();
  const notifier = new RecordingNotifier();
  const signals: [number, string][] = [];
  const sampled: number[] = [];
  const tree: ProcessTree = {
    detached: true,
    blocked: null,
    kill: (pid) => signals.push([pid, "SIGKILL"]),
    stop: (pid) => signals.push([pid, "SIGTERM"]),
  };
  const probe: ResourceProbe = (pid) => {
    sampled.push(pid);
    return Promise.resolve(readings(pid));
  };
  const deps: NodeProcessDeps = {
    clock,
    logger: new RecordingLogger(),
    notifier,
    tree,
    newId: () => "id",
    secrets: { protect: () => undefined },
    journal: new MemoryJournal(),
    settings: DEFAULT_NODE_PROCESS,
    ...(probed ? { probe } : {}),
  };
  let current = true;
  const logs: string[] = [];
  const host: GuardHost = {
    after: (ms, callback) => {
      clock.after(ms, callback);
    },
    current: () => current,
    log: (_level, message) => logs.push(message),
  };
  const spec = { ...rawNodeSpec(), identity: { ...rawNodeSpec().identity, name: "Summarize" } };
  return {
    clock,
    notifier,
    signals,
    sampled,
    deps,
    host,
    spec,
    logs,
    exit: () => {
      current = false;
    },
    /** One sample period: the timer fires, then the probe's answer is judged. */
    tick: async (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        clock.advance(EVERY);
        await settle();
      }
    },
  };
}

describe("the resource guard", () => {
  it("samples the one process it watches once per period", async () => {
    const h = harness(() => QUIET);
    guardResources(4242, h.spec, h.deps, h.host);
    await h.tick(3);
    expect(h.sampled).toEqual([4242, 4242, 4242]);
    expect(h.signals).toEqual([]);
  });

  it("stops a sustained memory breach politely, then forced, and tells the person", async () => {
    const h = harness(() => ({ ...QUIET, memoryMb: 2048 }));
    guardResources(4242, h.spec, h.deps, h.host);
    await h.tick(8); // over from 10 s, still over at 80 s: past the 60 s of grace
    expect(h.signals).toEqual([[4242, "SIGTERM"]]);
    expect(h.notifier.notices).toEqual([
      {
        kind: "node-over-limit",
        subject: "Summarize",
        detail:
          "Its process used memory 2048 MB, over its limit of 1024 MB, for 70 s, " +
          "so Reload stopped it and started it again",
      },
    ]);
    h.clock.advance(DEFAULT_NODE_PROCESS.resources.stopTimeoutMs);
    expect(h.signals).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
    // Acting ends this watch: its exit restarts the process, which gets a watch of its own.
    await h.tick(3);
    expect(h.sampled).toHaveLength(8);
  });

  it("does not force a process that stopped when asked", async () => {
    const h = harness(() => ({ ...QUIET, children: 40 }));
    guardResources(4242, h.spec, h.deps, h.host);
    await h.tick(8);
    h.exit();
    h.clock.advance(DEFAULT_NODE_PROCESS.resources.stopTimeoutMs);
    expect(h.signals).toEqual([[4242, "SIGTERM"]]);
  });

  it("gives a restarted process a fresh grace window, not the clock of the run it replaced", async () => {
    const h = harness(() => ({ ...QUIET, memoryMb: 2048 }));
    guardResources(4242, h.spec, h.deps, h.host);
    await h.tick(8);
    expect(h.signals).toEqual([[4242, "SIGTERM"]]);
    // The next process of the same instance: over its limit from its first sample, too.
    guardResources(4343, h.spec, h.deps, h.host);
    const polite = (): number[] =>
      h.signals.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid);
    await h.tick(7);
    expect(polite()).toEqual([4242]);
    await h.tick(1);
    expect(polite()).toEqual([4242, 4343]);
  });

  it("is watched against the limits its package declared", async () => {
    const h = harness(() => ({ ...QUIET, memoryMb: 2048 }));
    const spec = { ...h.spec, limits: { ...DEFAULT_LIMITS, memoryMb: 4096 } };
    guardResources(4242, spec, h.deps, h.host);
    await h.tick(10);
    expect(h.signals).toEqual([]);
  });

  it("only tells of sustained CPU, leaves the process running, and clears when it calms", async () => {
    let cpu = 0;
    let busy = true;
    const h = harness(() => {
      cpu += busy ? 10 : 0; // a full core while busy
      return { ...QUIET, cpuSeconds: cpu };
    });
    guardResources(4242, h.spec, h.deps, h.host);
    await h.tick(9);
    expect(h.signals).toEqual([]);
    expect(h.notifier.notices[0]).toMatchObject({ kind: "node-busy", subject: "Summarize" });
    busy = false;
    await h.tick(20);
    expect(h.notifier.cleared).toEqual(["node-busy Summarize"]);
    expect(h.signals).toEqual([]);
  });

  it("judges nothing from no reading, and keeps watching", async () => {
    const h = harness(() => null);
    guardResources(4242, h.spec, h.deps, h.host);
    await h.tick(10);
    expect(h.sampled).toHaveLength(10);
    expect(h.signals).toEqual([]);
  });

  it("stops watching once the process is gone, even with a sample in flight", async () => {
    const h = harness(() => ({ ...QUIET, memoryMb: 2048 }));
    guardResources(4242, h.spec, h.deps, h.host);
    await h.tick(7);
    h.clock.advance(EVERY); // the sample that would find it sustained is taken...
    h.exit(); // ...and the process exits before its answer is judged
    await settle();
    await h.tick(3);
    expect(h.sampled).toHaveLength(8);
    expect(h.signals).toEqual([]);
  });

  it("watches nothing without a probe or a process", async () => {
    const unprobed = harness(() => QUIET, false);
    guardResources(4242, unprobed.spec, unprobed.deps, unprobed.host);
    const h = harness(() => QUIET);
    guardResources(undefined, h.spec, h.deps, h.host);
    expect(unprobed.clock.pending + h.clock.pending).toBe(0);
    await h.tick(3);
    expect(h.sampled).toEqual([]);
  });
});
