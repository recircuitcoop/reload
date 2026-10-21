// The resource watchdog against a real process (plan 0031 group A): the raw fixture node is
// measured by the real probe (ps, lsof or /proc), kept over a memory limit past its grace
// window, stopped politely through its process group, and restarted through the crash-loop
// breaker, with a notice to the person. Windows is not measured, so there is nothing to see.

import { afterEach, describe, expect, it } from "vitest";

import { processTreeFor, type ProcessTree } from "../../src/adapters/process/process-tree";
import { resourceProbeFor } from "../../src/adapters/process/resource-probe";
import { DEFAULT_LIMITS } from "../../src/domain/supervision/resources";
import type { NodeProcess } from "../../src/ports/node-process";
import { alive, startRaw, waitFor } from "../fixtures/raw-node/fixture";

const started: NodeProcess[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("redeploy")));
});

describe.skipIf(process.platform === "win32")("the resource watchdog", () => {
  it("stops a real process kept over its memory limit, signals only it, and restarts it", async () => {
    const real = processTreeFor(process.platform);
    const signalled: [number, string][] = [];
    const tree: ProcessTree = {
      ...real,
      stop: (pid) => {
        signalled.push([pid, "SIGTERM"]);
        real.stop(pid);
      },
    };
    const raw = startRaw({
      tree,
      probe: resourceProbeFor(process.platform),
      // 1 MB: any Python process is over it. No grace, so the second sample acts.
      limits: { ...DEFAULT_LIMITS, memoryMb: 1, graceMs: 0 },
      settings: {
        respawnDelayMs: 100,
        resources: { sampleEveryMs: 100, stopTimeoutMs: 5_000 },
      },
    });
    started.push(raw.node);
    await waitFor("the first process", () => raw.node.pid !== null);
    const first = raw.node.pid as number;

    await waitFor("the stop", () => signalled.length > 0, 10_000);
    await waitFor("the restart", () => raw.node.pid !== null && raw.node.pid !== first, 10_000);

    // Only the process it spawned was signalled, and that process is gone.
    expect(signalled[0]).toEqual([first, "SIGTERM"]);
    expect(alive(first)).toBe(false);
    expect(raw.logger.has(/over its limits \(memory \d+ MB, over its limit of 1 MB/)).toBe(true);
    expect(raw.logger.has(/process exited unexpectedly \(signal SIGTERM\)/)).toBe(true);
    // The stop counts as an exit, like any other, against the crash-loop breaker.
    expect(raw.crashes[0]).toBe(false);
    expect(raw.notifier.notices[0]).toMatchObject({ kind: "node-over-limit", subject: "raw" });
  });
});
