// adapters/process/node-heartbeat.ts on its own: the pings it turns into frames, the pongs it turns
// back into answers with their progress marker and health, and what a stale verdict leads to,
// with a recording heartbeat in place of the application's. The whole judgement, against a real
// process, is test/integration/node-process.test.ts.
import { describe, expect, it } from "vitest";

import type { RuntimeFrame } from "../../src/adapters/process/codec";
import { NodeHeartbeat, nodeHeartbeat } from "../../src/adapters/process/node-heartbeat";
import {
  DEFAULT_NODE_PROCESS,
  type NodeProcessDeps,
} from "../../src/adapters/process/node-process";
import type { HeartbeatFactory, Pingable } from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import { RecordingLogger, RecordingNotifier, rawNodeSpec } from "../fixtures/raw-node/fixture";

const STABILITY = { heartbeatIntervalMs: 30_000, staleAfterMs: null };

interface Options {
  readonly running?: boolean;
  readonly notifier?: RecordingNotifier;
  readonly restartable?: boolean;
  readonly pid?: number | null;
}

function harness(options: Options = {}) {
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
  const spec = {
    ...rawNodeSpec(),
    stability: STABILITY,
    ...(options.restartable === undefined ? {} : { restartable: options.restartable }),
  };
  const subject = new NodeHeartbeat(spec, deps, {
    who: "[reload-rawnode-raw n1]",
    write: (frame) => {
      written.push(frame);
      return options.running ?? true;
    },
    pid: () => (options.pid === undefined ? 4242 : options.pid),
  });
  subject.started();
  let sent = 0;
  /** Ping, and answer that ping with `healthy` and `progress`. */
  const answer = async (healthy?: boolean, progress?: number): Promise<unknown> => {
    const ping = target?.ping(30_000);
    subject.pong(`ping-${String((sent += 1))}`, healthy, progress);
    return await ping;
  };
  return {
    subject,
    clock,
    logger,
    notifier,
    written,
    killed,
    answer,
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
    const declared = { ...rawNodeSpec(), stability: STABILITY };
    expect(nodeHeartbeat(declared, {} as NodeProcessDeps, target)).toBeNull();
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

  it("hands the heartbeat the node's progress marker with the answer", async () => {
    const h = harness();
    await expect(h.answer(undefined, 1234.5)).resolves.toBe(1234.5);
    await expect(h.answer()).resolves.toBeUndefined();
  });

  it("a ping with no pong before its timeout is unanswered, and a late pong changes nothing", async () => {
    const h = harness();
    const unanswered = h.target()?.ping(30_000);
    h.clock.advance(30_000);
    await expect(unanswered).rejects.toThrow("no pong within 30000 ms");
    h.subject.pong("ping-1", false);
    expect(h.notifier.notices).toEqual([]);
  });

  it("a ping with no process to send it to is unanswered at once", async () => {
    const h = harness({ running: false });
    await expect(h.target()?.ping(30_000)).rejects.toThrow("no process is running");
    expect(h.clock.pending).toBe(0);
  });

  it("stopping it stops the heartbeat, cancels every ping timer and a waiting restart", () => {
    const h = harness();
    void h
      .target()
      ?.ping(30_000)
      .catch(() => undefined);
    h.stale(95_000);
    expect(h.clock.pending).toBe(2);
    h.subject.stopped();
    expect(h.stopped()).toBe(1);
    expect(h.clock.pending).toBe(0);
    h.clock.advance(60_000);
    expect(h.killed).toEqual([]);
    h.subject.pong("ping-1"); // forgotten: nothing to settle
  });

  it("carries the node's health answer as it is: said once when it turns false, withdrawn when true", async () => {
    const h = harness();
    await h.answer(true);
    await h.answer(undefined);
    expect(h.notifier.notices).toEqual([]);
    expect(h.logger.has(/working again/)).toBe(false);
    await h.answer(false);
    await h.answer(false);
    expect(h.notifier.notices).toEqual([
      {
        kind: "node-unhealthy",
        subject: "raw",
        detail: "Its own health check says it is not working",
      },
    ]);
    expect(h.logger.has(/its health check says it is not working$/)).toBe(true);
    expect(h.killed).toEqual([]);
    await h.answer(true);
    expect(h.notifier.cleared).toEqual(["node-unhealthy raw", "node-unhealthy raw"]);
    expect(h.logger.has(/its health check says it is working again$/)).toBe(true);
  });

  it("a notice that cannot be raised is logged", async () => {
    const notifier = new RecordingNotifier();
    notifier.raise = () => {
      throw new Error("no window");
    };
    const h = harness({ notifier });
    await h.answer(false);
    expect(h.logger.has(/a notice could not be raised: Error: no window/)).toBe(true);
  });

  it("stuck: signals nothing at the verdict, says it once, and stops the process when its backoff has run out", () => {
    const h = harness();
    h.stale(95_000);
    expect(
      h.logger.has(
        /^\[reload-rawnode-raw n1\] stuck: no progress for 95 s; restarting it in 250 ms$/,
      ),
    ).toBe(true);
    expect(h.notifier.notices).toEqual([
      {
        kind: "node-stuck",
        subject: "raw",
        detail: "Its process made no progress, so Reload restarts it",
      },
    ]);
    h.clock.advance(249);
    expect(h.killed).toEqual([]);
    expect(h.subject.takeStuckExit()).toBe(false);
    h.clock.advance(1);
    expect(h.killed).toEqual([4242]);
    // The exit that follows is told once as a stuck one.
    expect(h.subject.takeStuckExit()).toBe(true);
    expect(h.subject.takeStuckExit()).toBe(false);
  });

  it("each stuck restart in a row waits longer, and the episode is said once until a process answers", async () => {
    const h = harness();
    h.stale(95_000);
    h.clock.advance(250);
    h.subject.started();
    h.stale(95_000);
    expect(h.logger.has(/restarting it in 500 ms$/)).toBe(true);
    expect(h.notifier.notices).toHaveLength(1);
    h.clock.advance(500);
    expect(h.killed).toEqual([4242, 4242]);
    // A new process answers: the episode is over, its notice withdrawn.
    h.subject.started();
    await h.answer(undefined, 1);
    expect(h.notifier.cleared).toEqual(["node-stuck raw"]);
    expect(h.logger.has(/answers again after being stuck$/)).toBe(true);
    // Still inside its first window, the run of stuck restarts is not over yet.
    h.stale(95_000);
    expect(h.logger.has(/restarting it in 750 ms$/)).toBe(true);
    expect(h.notifier.notices).toHaveLength(2);
    // A process that answers past a whole window ends the run: the next starts again at 250.
    h.clock.advance(750);
    h.subject.started();
    h.clock.advance(90_000);
    await h.answer(undefined, 2);
    h.stale(95_000);
    expect(h.logger.lines.at(-1)?.text).toMatch(/restarting it in 250 ms$/);
  });

  it("a stuck process of a type never restarted is stopped without a notice of its own, and with none running nothing is killed", () => {
    const h = harness({ restartable: false, pid: null });
    h.stale(95_000);
    expect(h.logger.has(/stuck: no progress for 95 s; stopping it for good in 250 ms$/)).toBe(true);
    expect(h.notifier.notices).toEqual([]);
    h.clock.advance(250);
    expect(h.killed).toEqual([]);
    expect(h.subject.takeStuckExit()).toBe(false);
  });
});
