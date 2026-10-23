// The resource watchdog against a real process (plan 0031 group A): the raw fixture node is
// measured by the real probe (ps, lsof or /proc), kept over a memory limit past its grace
// window, stopped politely through its process group, and restarted through the crash-loop
// breaker, with a notice to the person; kept over it, it is stopped until the breaker trips.
// Windows is not measured, so there is nothing to see there.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JsonNodeRecords } from "../../src/adapters/process/node-records";
import { recordingWatchdog, stopLeftNodes } from "../../src/application/left-nodes";

import { processTreeFor, type ProcessTree } from "../../src/adapters/process/process-tree";
import { resourceProbeFor } from "../../src/adapters/process/resource-probe";
import { systemClock } from "../../src/adapters/system/clock";
import { resourceWatchdog } from "../../src/application/resource-watch";
import { DEFAULT_LIMITS } from "../../src/domain/supervision/resources";
import type { NodeProcess } from "../../src/ports/node-process";
import {
  alive,
  RecordingDelivery,
  startRaw,
  waitFor,
  type RawNode,
} from "../fixtures/raw-node/fixture";
import { RecordingLogger } from "../fakes/children";

const started: NodeProcess[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("redeploy")));
});

/** The raw node, watched every 100 ms against 1 MB (any Python is over it) with no grace. */
function overItsLimit(
  tree: ProcessTree,
  crashLoop = { maxCrashes: 5, windowMs: 120_000 },
  restartable = true,
): RawNode {
  const raw = startRaw({
    restartable,
    tree,
    watchdog: resourceWatchdog({
      probe: resourceProbeFor(process.platform),
      clock: systemClock,
      pace: { sampleEveryMs: 100, stopTimeoutMs: 5_000 },
      log: () => undefined,
      signal: (pid, signal) => {
        process.kill(pid, signal);
      },
    }),
    limits: { ...DEFAULT_LIMITS, memoryMb: 1, graceMs: 0 },
    settings: { respawnDelayMs: 100, crashLoop },
  });
  started.push(raw.node);
  return raw;
}

function recording(): { tree: ProcessTree; stopped: number[] } {
  const real = processTreeFor(process.platform);
  const stopped: number[] = [];
  return {
    stopped,
    tree: {
      ...real,
      stop: (pid) => {
        stopped.push(pid);
        real.stop(pid);
      },
    },
  };
}

describe.skipIf(process.platform === "win32")("the resource watchdog", () => {
  it("stops a real process kept over its memory limit, signals only it, and restarts it", async () => {
    const { tree, stopped } = recording();
    const raw = overItsLimit(tree);
    await waitFor("the first process", () => raw.node.pid !== null);
    const first = raw.node.pid as number;

    await waitFor("the stop", () => stopped.length > 0, 10_000);
    await waitFor("the restart", () => raw.node.pid !== null && raw.node.pid !== first, 10_000);

    // Only the process it spawned was signalled, and that process is gone.
    expect(stopped[0]).toBe(first);
    expect(alive(first)).toBe(false);
    expect(raw.logger.has(/process exited unexpectedly \(signal SIGTERM\)/)).toBe(true);
    // The stop counts as an exit, like any other, against the crash-loop breaker.
    expect(raw.crashes[0]).toBe(false);
    expect(raw.notifier.notices[0]).toMatchObject({
      kind: "node-over-limit",
      subject: raw.spec.identity.id,
    });
    expect(raw.notifier.notices[0]?.detail).toMatch(
      /^The node raw used memory \d+ MB, over its limit of 1 MB, for \d+ s, so Reload stopped it and started it again$/,
    );
  });

  it("stops one whose type says never to restart it like any other, and leaves it stopped", async () => {
    const { tree, stopped } = recording();
    const raw = overItsLimit(tree, undefined, false);
    await waitFor("the first process", () => raw.node.pid !== null);
    const first = raw.node.pid as number;
    await waitFor("the stop", () => stopped.length > 0, 10_000);
    await waitFor("its end", () => raw.crashes.length === 1, 10_000);
    // Stopped politely for the breach, once, and never started again however long one waits.
    expect(stopped).toEqual([first]);
    expect(raw.crashes).toEqual([true]);
    // No restart was decided on: the instance refuses inputs as one that is stopped for good.
    const refused = new RecordingDelivery();
    raw.node.input({ payload: {}, topic: "t.in.v1", _msgid: "m" }, refused);
    expect(refused.ends[0]?.message).toBe(
      "the node process is stopped: this kind is never restarted",
    );
    expect(raw.node.pid).toBeNull();
    expect(raw.notifier.notices.map((notice) => notice.kind)).toEqual(["node-not-restarted"]);
    expect(raw.host.statuses.at(-1)?.text).toMatch(/its type says never to restart it$/);
  });

  it("counts every stop as an attempt, until the breaker stops restarting it", async () => {
    const { tree, stopped } = recording();
    const raw = overItsLimit(tree, { maxCrashes: 3, windowMs: 120_000 });
    await waitFor("the breaker", () => raw.crashes.at(-1) === true, 20_000);
    expect(raw.crashes).toEqual([false, false, true]);
    expect(new Set(stopped).size).toBe(3);
    // One episode: told once that it was started again, then the breaker's own notice.
    expect(raw.notifier.notices.map((notice) => notice.kind)).toEqual([
      "node-over-limit",
      "node-stopped",
    ]);
  });

  it("stops restarting it after five stops over its limits, however lenient the crash-loop limit", async () => {
    const { tree, stopped } = recording();
    const raw = overItsLimit(tree, { maxCrashes: 50, windowMs: 120_000 });
    await waitFor("the last stop", () => raw.crashes.at(-1) === true, 30_000);
    expect(raw.crashes).toEqual([false, false, false, false, true]);
    expect(new Set(stopped).size).toBe(5);
    expect(raw.notifier.notices.map((notice) => notice.kind)).toEqual([
      "node-over-limit",
      "node-stopped",
    ]);
    expect(raw.notifier.notices[1]?.detail).toMatch(
      /^Its process stopped after going over its resource limits or making no progress 5 times in 10 minutes \(the last: memory \d+ MB/,
    );
    expect(raw.node.pid).toBeNull();
  }, 40_000);
});

describe.skipIf(process.platform === "win32")(
  "node processes a crashed runtime left behind",
  () => {
    /** A process leading its own group, as a node process does; `stubborn` ignores SIGTERM. */
    function leftBehind(stubborn: boolean): { child: ChildProcess; gone: Promise<void> } {
      const script = stubborn ? 'trap "" TERM; while :; do sleep 1; done' : "exec sleep 300";
      const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
      const gone = new Promise<void>((resolve) => {
        child.on("exit", () => {
          resolve();
        });
      });
      return { child, gone };
    }

    it("and what a left node started is killed too when the node itself went when asked", async () => {
      const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "reload-left-"));
      const probe = resourceProbeFor(process.platform);
      // The node goes on SIGTERM; a child it started in its group ignores it.
      const script = '(trap "" TERM; while :; do sleep 1; done) & echo $!; wait';
      const node = spawn("/bin/sh", ["-c", script], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const child = await new Promise<number>((resolve) => {
        node.stdout.once("data", (chunk: Buffer) => {
          resolve(Number(chunk.toString().trim()));
        });
      });
      const pid = node.pid as number;
      const reading = (await probe([pid])).get(pid);
      expect(reading?.group?.map((member) => member.pid)).toContain(child);
      new JsonNodeRecords(userDir).write([
        { pid, identity: reading?.identity ?? { started: "", executable: null } },
      ]);
      const signals: string[] = [];
      await stopLeftNodes({
        store: new JsonNodeRecords(userDir),
        probe,
        signal: (target, signal) => {
          signals.push(`${signal} ${String(target)}`);
          process.kill(target, signal);
        },
        clock: systemClock,
        logger: new RecordingLogger(),
        waitMs: 1_000,
      });
      // Asked through its group; then the child that stayed, by its own pid, read again just now.
      expect(signals).toEqual([`SIGTERM -${String(pid)}`, `SIGKILL ${String(child)}`]);
      await waitFor("the child gone", () => !alive(child), 3_000);
      fs.rmSync(userDir, { recursive: true, force: true });
    });

    it("are recorded by the runtime, and stopped by the shell before the next one: politely, then killed", async () => {
      const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "reload-left-"));
      const probe = resourceProbeFor(process.platform);
      const polite = leftBehind(false);
      const stubborn = leftBehind(true);
      const pids = [polite.child.pid as number, stubborn.child.pid as number];
      // The runtime's side: each node process recorded with its identity while it is watched.
      const watchdog = recordingWatchdog(() => () => undefined, {
        probe,
        store: new JsonNodeRecords(userDir),
        log: () => undefined,
      });
      for (const pid of pids) {
        watchdog({
          pid,
          limits: DEFAULT_LIMITS,
          stop: () => undefined,
          kill: () => undefined,
          current: () => true,
          stopped: () => undefined,
        });
      }
      await waitFor("both recorded", () => new JsonNodeRecords(userDir).read().length === 2);
      // The runtime crashed (its watches never ended); the shell reads the file before a fork.
      const signals: string[] = [];
      const logger = new RecordingLogger();
      await stopLeftNodes({
        store: new JsonNodeRecords(userDir),
        probe,
        signal: (pid, signal) => {
          signals.push(`${signal} ${String(pid)}`);
          process.kill(pid, signal);
        },
        clock: systemClock,
        logger,
        waitMs: 1_000,
      });
      await Promise.all([polite.gone, stubborn.gone]);
      const [quiet, hard] = pids.map((pid) => String(pid)) as [string, string];
      // Both asked first, in the order they were recorded; then only the stubborn one killed.
      expect(signals.slice(0, 2).sort()).toEqual([`SIGTERM -${quiet}`, `SIGTERM -${hard}`].sort());
      expect(signals.slice(2)).toEqual([`SIGKILL -${hard}`]);
      expect(pids.some(alive)).toBe(false);
      expect(new JsonNodeRecords(userDir).read()).toEqual([]);
      expect(logger.lines[0]).toMatch(/^WARN stopping 2 node process\(es\) the last runtime left/);
      fs.rmSync(userDir, { recursive: true, force: true });
    });
  },
);
