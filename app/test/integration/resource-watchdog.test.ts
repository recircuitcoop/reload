// The resource watchdog against a real process (plan 0031 group A): the raw fixture node is
// measured by the real probe (ps, lsof or /proc), kept over a memory limit past its grace
// window, stopped politely through its process group, and restarted through the crash-loop
// breaker, with a notice to the person; kept over it, it is stopped until the breaker trips.
// Windows is not measured, so there is nothing to see there.

import { afterEach, describe, expect, it } from "vitest";

import { processTreeFor, type ProcessTree } from "../../src/adapters/process/process-tree";
import { resourceProbeFor } from "../../src/adapters/process/resource-probe";
import { systemClock } from "../../src/adapters/system/clock";
import { resourceWatchdog } from "../../src/application/resource-watch";
import { DEFAULT_LIMITS } from "../../src/domain/supervision/resources";
import type { NodeProcess } from "../../src/ports/node-process";
import { alive, startRaw, waitFor, type RawNode } from "../fixtures/raw-node/fixture";

const started: NodeProcess[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("redeploy")));
});

/** The raw node, watched every 100 ms against 1 MB (any Python is over it) with no grace. */
function overItsLimit(
  tree: ProcessTree,
  crashLoop = { maxCrashes: 5, windowMs: 120_000 },
): RawNode {
  const raw = startRaw({
    tree,
    watchdog: resourceWatchdog({
      probe: resourceProbeFor(process.platform),
      clock: systemClock,
      pace: { sampleEveryMs: 100, stopTimeoutMs: 5_000 },
      log: () => undefined,
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
      /^The node raw used memory \d+ MB, over its limit of 1 MB, for 0 s, so Reload stopped it and started it again$/,
    );
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
      /^Its process stopped after going over its resource limits 5 times in 10 minutes \(the last: memory \d+ MB/,
    );
    expect(raw.node.pid).toBeNull();
  }, 40_000);
});
