// The shell's managed processes under the resource watchdog (application/managed-watch.ts): the
// runtime and the services process each generation, and the Anytype app only when Reload
// started it (tests/test_helper_detection.py D5, tests/test_helper_tick.py, helper/breaker.py).

import { describe, expect, it } from "vitest";

import {
  managedWatch,
  watchManaged,
  type WatchedAnytype,
  type WatchedChild,
} from "../../src/application/managed-watch";
import { DEFAULT_WATCH_PACE } from "../../src/application/resource-watch";
import type { ChildName, ChildState, ChildStatus } from "../../src/domain/supervision/child-state";
import {
  DEFAULT_LIMITS,
  type DeclaredLimits,
  type ResourceSample,
} from "../../src/domain/supervision/resources";
import type { ProcessReading } from "../../src/ports/resource-watch";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger, RecordingNotifier } from "../fixtures/raw-node/fixture";

const QUIET: ResourceSample = { memoryMb: 100, cpuSeconds: 0, openFiles: 10, children: 0 };
const HUNGRY: ResourceSample = { ...QUIET, memoryMb: 2048 };
const EVERY = DEFAULT_WATCH_PACE.sampleEveryMs;
const STOP = DEFAULT_WATCH_PACE.stopTimeoutMs;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

class FakeChild implements WatchedChild {
  readonly #listeners: ((status: ChildStatus) => void)[] = [];
  readonly #stopping: (() => void)[] = [];
  #status: ChildStatus;
  /** Each stop over a limit: the pid, and the sentence of a last one. */
  readonly stops: [number, string | null][] = [];

  constructor(readonly child: ChildName) {
    this.#status = { child, state: "starting", generation: 0, pid: null, port: null, error: null };
  }

  status(): ChildStatus {
    return this.#status;
  }

  onStatus(listener: (status: ChildStatus) => void): void {
    this.#listeners.push(listener);
  }

  onStopping(listener: () => void): void {
    this.#stopping.push(listener);
  }

  stopOverLimit(forGood: string | null = null): boolean {
    this.stops.push([this.#status.pid ?? -1, forGood]);
    return true;
  }

  quit(): void {
    for (const listener of this.#stopping) {
      listener();
    }
  }

  set(state: ChildState, pid: number | null): void {
    this.#status = { ...this.#status, state, pid, generation: this.#status.generation + 1 };
    for (const listener of this.#listeners) {
      listener(this.#status);
    }
  }
}

class FakeAnytype implements WatchedAnytype {
  stopped = 0;
  readonly #ended: (() => void)[] = [];
  constructor(public startedPid: number | null) {}
  stopOverLimit(): void {
    this.stopped += 1;
    this.exit();
  }
  onEnded(listener: () => void): void {
    this.#ended.push(listener);
  }
  exit(): void {
    this.startedPid = null;
    for (const listener of this.#ended.splice(0)) {
      listener();
    }
  }
}

function harness(samples: Record<number, ResourceSample>) {
  const clock = new FakeClock();
  const notifier = new RecordingNotifier();
  const passes: number[][] = [];
  const hostsAsked: number[][] = [];
  const settings: { limits: DeclaredLimits | undefined } = { limits: undefined };
  const signals: [number, string][] = [];
  const parts = {
    probe: (pids: readonly number[], hosts: ReadonlySet<number> = new Set()) => {
      passes.push([...pids]);
      hostsAsked.push([...hosts]);
      const readings = new Map<number, ProcessReading>();
      for (const pid of pids) {
        readings.set(pid, { sample: samples[pid] ?? QUIET, identity: identity(pid) });
      }
      return Promise.resolve(readings);
    },
    settings: { readLimitDefaults: (): DeclaredLimits | undefined => settings.limits },
    clock,
    logger: new RecordingLogger(),
    notifier,
    signal: (pid: number, signal: "SIGKILL") => {
      signals.push([pid, signal]);
    },
  };
  return {
    clock,
    notifier,
    passes,
    hostsAsked,
    settings,
    signals,
    parts,
    sampled: () => passes.flat(),
    tick: async (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        clock.advance(EVERY);
        await settle();
      }
    },
  };
}

const identity = (pid: number) => ({ started: `started-${String(pid)}`, executable: "/x" });

const noAnytype = (): Promise<WatchedAnytype> => Promise.resolve(new FakeAnytype(null));

describe("the shell's managed processes", () => {
  it("are each sampled once per tick, in one read: the runtime, the services process and an Anytype Reload started", async () => {
    const h = harness({});
    const runtime = new FakeChild("runtime");
    const services = new FakeChild("services");
    const anytype = new FakeAnytype(300);
    watchManaged({ ...h.parts, children: [runtime, services], anytype: Promise.resolve(anytype) });
    runtime.set("running", 100);
    services.set("running", 200);
    await settle();
    await h.tick(2);
    expect(h.passes).toEqual([
      [100, 200, 300],
      [100, 200, 300],
    ]);
  });

  it("never watch an adopted Anytype, nor stop it", async () => {
    const h = harness({});
    const adopted = new FakeAnytype(null);
    watchManaged({ ...h.parts, children: [], anytype: Promise.resolve(adopted) });
    await settle();
    await h.tick(10);
    expect(h.passes).toEqual([]);
    expect(adopted.stopped).toBe(0);
  });

  it("stop an Anytype Reload started politely after the same grace window, and say so", async () => {
    const h = harness({ 300: HUNGRY });
    const anytype = new FakeAnytype(300);
    watchManaged({ ...h.parts, children: [], anytype: Promise.resolve(anytype) });
    await settle();
    await h.tick(7); // over from 10 s; at 70 s only exactly the grace window: a spike
    expect(anytype.stopped).toBe(0);
    await h.tick(1);
    // Its own quit asks politely and ends it after its grace; never a kill by pid here.
    expect(anytype.stopped).toBe(1);
    h.clock.advance(STOP);
    await settle();
    expect(h.signals).toEqual([]);
    expect(h.notifier.notices).toEqual([
      {
        kind: "anytype-over-limit",
        subject: "Anytype",
        detail: "It used memory 2048 MB, over its limit of 1024 MB, for 70 s, so Reload stopped it",
      },
    ]);
  });

  it("stop watching an Anytype Reload started once it exits by itself", async () => {
    const h = harness({ 300: HUNGRY });
    const anytype = new FakeAnytype(300);
    watchManaged({ ...h.parts, children: [], anytype: Promise.resolve(anytype) });
    await settle();
    await h.tick(3);
    anytype.exit(); // the person quit it, or it relaunched to update
    expect(h.clock.pending).toBe(0);
    await h.tick(10);
    expect(h.passes).toHaveLength(3);
    expect(anytype.stopped).toBe(0);
  });

  it("stop a child over its limit, kill it if it stays, and say it was restarted once it is", async () => {
    const h = harness({ 100: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({ ...h.parts, children: [runtime], anytype: noAnytype() });
    runtime.set("running", 100);
    await h.tick(8);
    expect(runtime.stops).toEqual([[100, null]]);
    h.clock.advance(STOP);
    await settle();
    expect(h.signals).toEqual([[100, "SIGKILL"]]);
    expect(h.notifier.notices).toEqual([]);
    runtime.set("down", null);
    runtime.set("running", 101);
    expect(h.notifier.notices).toEqual([
      {
        kind: "child-over-limit",
        subject: "runtime",
        detail:
          "It used memory 2048 MB, over its limit of 1024 MB, for 70 s, " +
          "so Reload stopped it and started it again",
      },
    ]);
    // The next generation is watched afresh.
    await h.tick(1);
    expect(h.sampled().at(-1)).toBe(101);
  });

  it("say it once an episode, and at the fifth stop in ten minutes end the child for good", async () => {
    const h = harness({});
    const hungry = new Set<number>();
    h.parts.probe = (pids) => {
      const readings = new Map<number, ProcessReading>();
      for (const pid of pids) {
        const sample = hungry.has(pid) ? HUNGRY : QUIET;
        readings.set(pid, { sample, identity: identity(pid) });
      }
      return Promise.resolve(readings);
    };
    const runtime = new FakeChild("runtime");
    watchManaged({ ...h.parts, children: [runtime], anytype: noAnytype() });
    for (let generation = 1; generation <= 5; generation += 1) {
      const pid = 100 + generation;
      hungry.add(pid);
      runtime.set("running", pid);
      await h.tick(8); // each stop takes the 60 s grace window and more: 80 s here
      runtime.set("down", null);
    }
    expect(runtime.stops.map(([, forGood]) => forGood)).toEqual([
      null,
      null,
      null,
      null,
      "The Reload runtime went over its resource limits 5 times in 10 minutes (the last: " +
        "memory 2048 MB, over its limit of 1024 MB, for 70 s), so it is no longer restarted. " +
        "Press Restart to try again.",
    ]);
    // Restarted four times in the episode, and told once.
    expect(h.notifier.notices.map((notice) => notice.kind)).toEqual(["child-over-limit"]);
    // The supervisor's down-for-good carries its one notice; a person's Restart counts afresh.
    runtime.set("down-for-good", null);
    hungry.add(200);
    runtime.set("running", 200);
    await h.tick(8);
    expect(runtime.stops.at(-1)).toEqual([200, null]);
  });

  it("read the person's limits again at every start, so a fix and a Restart take effect", async () => {
    const h = harness({ 100: HUNGRY, 101: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({ ...h.parts, children: [runtime], anytype: noAnytype() });
    runtime.set("running", 100);
    await h.tick(8);
    expect(runtime.stops).toHaveLength(1);
    h.settings.limits = { memory_mb: 4096 }; // the person raises it...
    runtime.set("down", null);
    runtime.set("running", 101); // ...and the next generation is watched against it
    await h.tick(10);
    expect(runtime.stops).toHaveLength(1);
  });

  it("tell the probe the runtime hosts node processes, and the services process does not", async () => {
    const h = harness({});
    const runtime = new FakeChild("runtime");
    const services = new FakeChild("services");
    watchManaged({ ...h.parts, children: [runtime, services], anytype: noAnytype() });
    runtime.set("running", 100);
    services.set("running", 200);
    await settle();
    await h.tick(1);
    expect(h.hostsAsked).toEqual([[100]]);
  });

  it("send nothing to a child once a quit has begun, even one 55 s over its limit", async () => {
    const h = harness({ 100: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({ ...h.parts, children: [runtime], anytype: noAnytype() });
    runtime.set("running", 100);
    await h.tick(6); // over from 10 s: 50 s over its line at 60 s...
    h.clock.advance(5_000); // ...and 55 s when the quit begins
    runtime.quit();
    expect(h.clock.pending).toBe(0);
    await h.tick(10);
    expect(runtime.stops).toEqual([]);
    expect(h.signals).toEqual([]);
  });

  it("leave the breaker's own words when a stopped child is not started again", async () => {
    const h = harness({ 100: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({ ...h.parts, children: [runtime], anytype: noAnytype() });
    runtime.set("running", 100);
    await h.tick(8);
    runtime.set("down-for-good", null);
    runtime.set("running", 102); // a person pressed Restart
    expect(h.notifier.notices).toEqual([]);
  });

  it("do not force a child that stopped when asked", async () => {
    const h = harness({ 100: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({ ...h.parts, children: [runtime], anytype: noAnytype() });
    runtime.set("running", 100);
    await h.tick(8);
    runtime.set("down", null);
    h.clock.advance(STOP);
    await settle();
    expect(h.signals).toEqual([]);
  });

  it("are watched under the person's own limits, and a kill of a process already gone is quiet", () => {
    const h = harness({});
    const deps = managedWatch({
      ...h.parts,
      settings: { readLimitDefaults: () => ({ memory_mb: 4096 }) },
      signal: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    });
    expect(deps.limits()).toEqual({ ...DEFAULT_LIMITS, memoryMb: 4096 });
    expect(deps.now()).toBe(0);
    expect(() => {
      deps.kill(100);
    }).not.toThrow();
  });
});
