// A child stopped at its own crash-loop limit leaves every other process alone (the old helper's
// breaker: a quarantined plugin or MCP server never costs the host): a real node process trips
// its breaker inside a supervised runtime, and an MCP child trips its own, each with its own
// budget, while the runtime, the services process and the other child carry on.
import { describe, expect, it } from "vitest";

import { AnytypeService } from "../../src/application/anytype-service";
import { DEFAULT_BACKOFF } from "../../src/domain/supervision/backoff";
import { MCP_STABILITY } from "../../src/domain/supervision/staleness";
import { flush, FakeAnytypeApi, FakeMcpLauncher, MemorySecretStore } from "../fakes/anytype";
import { RecordingLogger, RecordingNotifier, obedient } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { supervised } from "../fakes/supervised";
import { startRaw, waitFor } from "../fixtures/raw-node/fixture";

const KEY = "service-key-0123456789";
const TOOLS = [{ name: "API-list-spaces", inputSchema: {} }];

/** The Anytype core service with a fake MCP child, ready. */
async function mcpService() {
  const clock = new FakeClock();
  const secrets = new MemorySecretStore();
  secrets.write("anytype-api-key", KEY);
  const launcher = new FakeMcpLauncher();
  launcher.prepare = (child) => {
    child.session.initializeWith = TOOLS;
  };
  const notifier = new RecordingNotifier();
  const service = new AnytypeService({
    settings: {
      apiBaseUrl: "http://127.0.0.1:31009",
      backoff: DEFAULT_BACKOFF,
      crashLoop: { maxCrashes: 5, windowMs: 120_000 },
      profile: MCP_STABILITY,
      keyLocation: "the key file",
    },
    secrets,
    api: new FakeAnytypeApi(),
    launcher,
    publishKey: () => undefined,
    childLine: () => undefined,
    command: "node anytype-mcp/bin/cli.mjs",
    clock,
    logger: new RecordingLogger(),
    notifier,
  });
  service.start();
  clock.advance(0);
  await flush();
  const advance = async (ms: number): Promise<void> => {
    for (let moved = 0; moved < ms; moved += 1_000) {
      clock.advance(1_000);
      await flush();
    }
  };
  return { service, launcher, notifier, advance };
}

describe("a child stopped at its crash-loop limit", () => {
  it("a plugin stopped for good leaves the host alone: the runtime and the MCP child run on", async () => {
    const runtime = supervised(obedient);
    runtime.supervisor.start();
    runtime.clock.advance(1);
    const before = runtime.supervisor.status();
    expect(before.state).toBe("running");
    const mcp = await mcpService();
    expect(mcp.service.status().state).toBe("ready");

    // A real node process crashes at every start, inside this runtime: each exit is told to the
    // shell over the channel, as runtime/main.ts does, until its own breaker stops it.
    const clock = new FakeClock();
    const node = startRaw({ clock, config: { exit_at_start: 3 } });
    for (let exit = 1; exit <= 5; exit += 1) {
      await waitFor(`exit ${String(exit)}`, () => node.crashes.length === exit);
      runtime.launcher.current.send({
        v: 1,
        t: "node-crash",
        stopped: node.crashes.at(-1) === true,
      });
      clock.advance(1_000);
    }
    await waitFor("the stop", () => node.notifier.notices.length === 1);
    expect(node.crashes).toEqual([false, false, false, false, true]);

    // The host: the same runtime generation, running, with nothing counted against it.
    expect(runtime.supervisor.status()).toEqual(before);
    expect(runtime.notifier.notices).toEqual([]);
    expect(runtime.launcher.children).toHaveLength(1);
    // And the MCP child: the same child, still ready.
    expect(mcp.service.status().state).toBe("ready");
    expect(mcp.launcher.children).toHaveLength(1);
    await node.node.close("removed");
  });

  it("an MCP child stopped for good leaves the host alone: the crash budgets are separate", async () => {
    const runtime = supervised(obedient);
    runtime.supervisor.start();
    runtime.clock.advance(1);
    const mcp = await mcpService();
    // The MCP child spends its whole budget: five exits, then down for good.
    for (let exit = 1; exit <= 5; exit += 1) {
      mcp.launcher.current.exit(1);
      await mcp.advance(5_000);
    }
    expect(mcp.service.status().state).toBe("down-for-good");
    expect(mcp.notifier.notices.map((notice) => notice.kind)).toEqual(["mcp-child-stopped"]);
    // The runtime's budget is untouched: it still takes four crashes in a row and restarts.
    const first = runtime.supervisor.status().generation;
    for (let crash = 1; crash <= 4; crash += 1) {
      runtime.launcher.current.exit(1);
      runtime.clock.advance(5_001);
      expect(runtime.supervisor.status().state).toBe("running");
    }
    expect(runtime.supervisor.status().generation).toBe(first + 4);
    expect(runtime.notifier.notices).toEqual([]);
  });
});
