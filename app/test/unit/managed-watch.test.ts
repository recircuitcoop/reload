// The shell's managed processes under the resource watchdog (application/managed-watch.ts): the
// runtime and the services process each generation, and the Anytype app only when Reload
// started it (tests/test_helper_detection.py D5, tests/test_helper_tick.py).

import { describe, expect, it } from "vitest";

import {
  managedWatch,
  watchManaged,
  type WatchedAnytype,
  type WatchedChild,
} from "../../src/application/managed-watch";
import { DEFAULT_WATCH_PACE } from "../../src/application/resource-watch";
import type { ChildName, ChildState, ChildStatus } from "../../src/domain/supervision/child-state";
import { DEFAULT_LIMITS, type ResourceSample } from "../../src/domain/supervision/resources";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger, RecordingNotifier } from "../fixtures/raw-node/fixture";

const QUIET: ResourceSample = { memoryMb: 100, cpuSeconds: 0, openFiles: 10, children: 0 };
const HUNGRY: ResourceSample = { ...QUIET, memoryMb: 2048 };
const EVERY = DEFAULT_WATCH_PACE.sampleEveryMs;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

class FakeChild implements WatchedChild {
  readonly #listeners: ((status: ChildStatus) => void)[] = [];
  #status: ChildStatus;
  readonly stops: number[] = [];

  constructor(readonly child: ChildName) {
    this.#status = { child, state: "starting", generation: 0, pid: null, port: null, error: null };
  }

  status(): ChildStatus {
    return this.#status;
  }

  onStatus(listener: (status: ChildStatus) => void): void {
    this.#listeners.push(listener);
  }

  stopOverLimit(): boolean {
    this.stops.push(this.#status.pid ?? -1);
    return true;
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
  constructor(public startedPid: number | null) {}
  stopOverLimit(): void {
    this.stopped += 1;
    this.startedPid = null;
  }
}

function harness(samples: Record<number, ResourceSample>) {
  const clock = new FakeClock();
  const notifier = new RecordingNotifier();
  const sampled: number[] = [];
  const signals: [number, string][] = [];
  const parts = {
    probe: (pid: number) => {
      sampled.push(pid);
      return Promise.resolve(samples[pid] ?? QUIET);
    },
    settings: { readLimitDefaults: () => undefined },
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
    sampled,
    signals,
    parts,
    tick: async (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        clock.advance(EVERY);
        await settle();
      }
    },
  };
}

describe("the shell's managed processes", () => {
  it("are each sampled once per tick: the runtime, the services process and an Anytype Reload started", async () => {
    const h = harness({});
    const runtime = new FakeChild("runtime");
    const services = new FakeChild("services");
    const anytype = new FakeAnytype(300);
    watchManaged({ ...h.parts, children: [runtime, services], anytype: Promise.resolve(anytype) });
    runtime.set("running", 100);
    services.set("running", 200);
    await settle();
    await h.tick(2);
    expect([...h.sampled].sort()).toEqual([100, 100, 200, 200, 300, 300]);
  });

  it("never watch an adopted Anytype, nor stop it", async () => {
    const h = harness({});
    const adopted = new FakeAnytype(null);
    watchManaged({ ...h.parts, children: [], anytype: Promise.resolve(adopted) });
    await settle();
    await h.tick(10);
    expect(h.sampled).toEqual([]);
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
    h.clock.advance(DEFAULT_WATCH_PACE.stopTimeoutMs);
    expect(h.signals).toEqual([]);
    expect(h.notifier.notices).toEqual([
      {
        kind: "anytype-over-limit",
        subject: "Anytype",
        detail: "It used memory 2048 MB, over its limit of 1024 MB, for 70 s, so Reload stopped it",
      },
    ]);
  });

  it("stop a child over its limit, kill it if it stays, and say it was restarted once it is", async () => {
    const h = harness({ 100: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({
      ...h.parts,
      children: [runtime],
      anytype: Promise.resolve(new FakeAnytype(null)),
    });
    runtime.set("running", 100);
    await h.tick(8);
    expect(runtime.stops).toEqual([100]);
    h.clock.advance(DEFAULT_WATCH_PACE.stopTimeoutMs);
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
    expect(h.sampled.at(-1)).toBe(101);
  });

  it("leave the breaker's own words when a stopped child is not started again", async () => {
    const h = harness({ 100: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({
      ...h.parts,
      children: [runtime],
      anytype: Promise.resolve(new FakeAnytype(null)),
    });
    runtime.set("running", 100);
    await h.tick(8);
    runtime.set("down-for-good", null);
    runtime.set("running", 102); // a person pressed Restart
    expect(h.notifier.notices).toEqual([]);
  });

  it("do not force a child that stopped when asked", async () => {
    const h = harness({ 100: HUNGRY });
    const runtime = new FakeChild("runtime");
    watchManaged({
      ...h.parts,
      children: [runtime],
      anytype: Promise.resolve(new FakeAnytype(null)),
    });
    runtime.set("running", 100);
    await h.tick(8);
    runtime.set("down", null);
    h.clock.advance(DEFAULT_WATCH_PACE.stopTimeoutMs);
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
    expect(deps.limits).toEqual({ ...DEFAULT_LIMITS, memoryMb: 4096 });
    expect(() => {
      deps.kill(100);
    }).not.toThrow();
  });
});
