// adapters/process/node-heartbeat.ts on its own: the pings it turns into frames and the pongs it
// turns back into answers, with a recording heartbeat in place of the application's. The whole
// judgement, against a real process, is test/integration/node-process.test.ts.
import { describe, expect, it } from "vitest";

import { NodeHeartbeat, nodeHeartbeat } from "../../src/adapters/process/node-heartbeat";
import {
  DEFAULT_NODE_PROCESS,
  type NodeProcessDeps,
} from "../../src/adapters/process/node-process";
import type { RuntimeFrame } from "../../src/adapters/process/codec";
import type { HeartbeatFactory, Pingable } from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import { RecordingLogger, RecordingNotifier, rawNodeSpec } from "../fixtures/raw-node/fixture";

const STABILITY = { heartbeatIntervalMs: 30_000, staleAfterMs: null };

function harness(options: { running?: boolean; notifier?: RecordingNotifier } = {}) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const notifier = options.notifier ?? new RecordingNotifier();
  const written: RuntimeFrame[] = [];
  const killed: number[] = [];
  let target: Pingable | null = null;
  let stale: ((silentForMs: number) => void) | null = null;
  let stopped = 0;
  const heartbeat: HeartbeatFactory = (watch) => {
    stale = watch.onStale;
    return {
      start: (pinged) => {
        target = pinged;
      },
      stop: () => {
        stopped += 1;
      },
    };
  };
  let ids = 0;
  const deps: NodeProcessDeps = {
    clock,
    logger,
    notifier,
    tree: {
      detached: true,
      blocked: null,
      kill: (pid) => killed.push(pid),
      stop: (pid) => killed.push(pid),
    },
    newId: () => `ping-${String((ids += 1))}`,
    secrets: { protect: () => undefined },
    journal: new MemoryJournal(),
    settings: DEFAULT_NODE_PROCESS,
    heartbeat,
  };
  const subject = new NodeHeartbeat({ ...rawNodeSpec(), stability: STABILITY }, deps, {
    who: "[reload-rawnode-raw n1]",
    write: (frame) => {
      written.push(frame);
      return options.running ?? true;
    },
    pid: () => 4242,
  });
  subject.started();
  return {
    subject,
    clock,
    logger,
    notifier,
    written,
    killed,
    target: () => target,
    stale: (ms: number) => stale?.(ms),
    stopped: () => stopped,
  };
}

describe("a node process's heartbeat", () => {
  it("is kept only for a type that declares one, in a runtime that keeps them", () => {
    const factory: HeartbeatFactory = () => ({ start: () => undefined, stop: () => undefined });
    const deps = { heartbeat: factory } as NodeProcessDeps;
    const target = { who: "x", write: () => true, pid: () => null };
    expect(nodeHeartbeat(rawNodeSpec(), deps, target)).toBeNull();
    expect(
      nodeHeartbeat({ ...rawNodeSpec(), stability: STABILITY }, {} as NodeProcessDeps, target),
    ).toBeNull();
    expect(() => new NodeHeartbeat(rawNodeSpec(), deps, target)).toThrow(RangeError);
  });

  it("sends a ping frame, and its pong is the answer, while a pong for an id never sent is ignored", async () => {
    const h = harness();
    const answered = h.target()?.ping(30_000);
    expect(h.written).toEqual([{ t: "ping", id: "ping-1" }]);
    h.subject.pong("ping-99");
    h.subject.pong("ping-1");
    await expect(answered).resolves.toBeUndefined();
    // The answer cancelled its timeout: nothing is left on the clock.
    expect(h.clock.pending).toBe(0);
  });

  it("a ping with no pong before its timeout is unanswered, and a late pong changes nothing", async () => {
    const h = harness();
    const unanswered = h.target()?.ping(30_000);
    h.clock.advance(30_000);
    await expect(unanswered).rejects.toThrow("no pong within 30000 ms");
    h.subject.pong("ping-1");
  });

  it("a ping with no process to send it to is unanswered at once", async () => {
    const h = harness({ running: false });
    await expect(h.target()?.ping(30_000)).rejects.toThrow("no process is running");
    expect(h.clock.pending).toBe(0);
  });

  it("stopping it stops the heartbeat, and the pings still out are never answered", () => {
    const h = harness();
    void h
      .target()
      ?.ping(30_000)
      .catch(() => undefined);
    h.subject.stopped();
    expect(h.stopped()).toBe(1);
    h.subject.pong("ping-1"); // forgotten: nothing to settle
  });

  it("carries the node's health answer as it is: said once when it turns false, withdrawn when true", async () => {
    const h = harness();
    let sent = 0;
    /** Ping, and answer that ping with `healthy`. */
    const answer = async (healthy?: boolean): Promise<void> => {
      const ping = h.target()?.ping(30_000);
      h.subject.pong(`ping-${String((sent += 1))}`, healthy);
      await ping;
    };
    await answer(true);
    await answer(undefined);
    expect(h.notifier.notices).toEqual([]);
    await answer(false);
    await answer(false);
    expect(h.notifier.notices).toEqual([
      {
        kind: "node-unhealthy",
        subject: "raw",
        detail: "Its own health check says it is not working",
      },
    ]);
    expect(h.logger.has(/its health check says it is not working$/)).toBe(true);
    expect(h.killed).toEqual([]);
    await answer(true);
    expect(h.notifier.cleared).toEqual(["node-unhealthy raw", "node-unhealthy raw"]);
    expect(h.logger.has(/its health check says it is working again$/)).toBe(true);
    // A pong for a ping never sent carries nothing, health included.
    h.subject.pong("ping-99", false);
    expect(h.notifier.notices).toHaveLength(1);
  });

  it("a health notice that cannot be raised is logged", async () => {
    const notifier = new RecordingNotifier();
    notifier.raise = () => {
      throw new Error("no window");
    };
    const h = harness({ notifier });
    const ping = h.target()?.ping(30_000);
    h.subject.pong("ping-1", false);
    await ping;
    expect(h.logger.has(/the health notice could not be raised: Error: no window/)).toBe(true);
  });

  it("stuck: logs it, tells the person once, and kills the process group", () => {
    const h = harness();
    h.stale(95_000);
    expect(h.killed).toEqual([4242]);
    expect(h.notifier.notices).toEqual([
      {
        kind: "node-stuck",
        subject: "raw",
        detail: "Its process answered nothing for 95 s, so Reload stopped it",
      },
    ]);
    expect(h.logger.has(/^\[reload-rawnode-raw n1\] stuck: answered no ping for 95 s/)).toBe(true);
  });

  it("a notice that cannot be raised is logged, and the process is killed all the same", () => {
    const notifier = new RecordingNotifier();
    notifier.raise = () => {
      throw new Error("no window");
    };
    const h = harness({ notifier });
    h.stale(95_000);
    expect(h.killed).toEqual([4242]);
    expect(h.logger.has(/the stuck-process notice could not be raised: Error: no window/)).toBe(
      true,
    );
  });
});
