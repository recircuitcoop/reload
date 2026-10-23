// The Anytype core service (plan 0018 §4.1; WI-0018-18): key, health gate, the MCP child's
// lifecycle, its heartbeat and staleness restart, backoff and breaker, and pairing.
import { describe, expect, it } from "vitest";
import {
  ANYTYPE_START_WAIT_MS,
  ANYTYPE_WAIT_STEP_MS,
  AnytypeService,
  serveAnytypeCall,
} from "../../src/application/anytype-service";
import { SessionError, ToolSurfaceMismatchError } from "../../src/domain/anytype/errors";
import { MCP_STABILITY } from "../../src/domain/supervision/staleness";
import { DEFAULT_LIMITS, MCP_LIMITS } from "../../src/domain/supervision/resources";
import { DEFAULT_WATCH_PACE, resourceWatchdog } from "../../src/application/resource-watch";
import type { ProcessReading, ResourceWatchdog } from "../../src/ports/resource-watch";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";
import { FakeAnytypeApi, FakeMcpLauncher, flush, MemorySecretStore } from "../fakes/anytype";

const KEY = "service-key-0123456789";
const TOOLS = [{ name: "API-search", inputSchema: { type: "object" } }];

function service(
  options: { key?: string | null; onReady?: () => void; watchdog?: ResourceWatchdog } = {},
) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const notifier = new RecordingNotifier();
  const secrets = new MemorySecretStore();
  const key = options.key === undefined ? KEY : options.key;
  if (key !== null) {
    secrets.write("anytype-api-key", key);
  }
  const api = new FakeAnytypeApi();
  const launcher = new FakeMcpLauncher();
  launcher.prepare = (child) => {
    child.session.initializeWith = TOOLS;
  };
  const published: string[] = [];
  const subject = new AnytypeService({
    settings: {
      apiBaseUrl: "http://127.0.0.1:31009",
      // 250 ms × n, so each wait below is its own number; the defaults are backoff.ts's tests'.
      backoff: { delaysMs: [250, 500, 750, 1_000, 1_250] },
      crashLoop: { maxCrashes: 5, windowMs: 120_000 },
      restartAttempts: 5,
      profile: MCP_STABILITY,
      keyLocation: "/home/x/.config/reload/anytype_api_key or /legacy/anytype_api_key",
    },
    secrets,
    api,
    launcher,
    publishKey: (k) => published.push(k),
    childLine: () => undefined,
    command: "node anytype-mcp/bin/cli.mjs",
    clock,
    logger,
    notifier,
    ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
    ...(options.watchdog === undefined ? {} : { watchdog: options.watchdog }),
  });
  const advance = async (ms: number, step = 1_000) => {
    let moved = 0;
    do {
      const by = Math.min(step, ms - moved);
      clock.advance(by);
      moved += by;
      await flush();
    } while (moved < ms);
  };
  return { subject, clock, logger, notifier, secrets, api, launcher, published, advance };
}

async function running(options: { key?: string | null } = {}) {
  const ctx = service(options);
  ctx.subject.start();
  await ctx.advance(0);
  return ctx;
}

describe("bringing the MCP child up", () => {
  it("with no key says so and starts nothing", async () => {
    const { subject, api, launcher } = await running({ key: null });
    expect(subject.status()).toMatchObject({ state: "no-key", childPid: null });
    expect(subject.status().detail).toContain("pair with Anytype");
    // Both places the key could come from are named.
    expect(subject.status().detail).toContain(
      "/home/x/.config/reload/anytype_api_key or /legacy/anytype_api_key",
    );
    expect(api.probes).toEqual([]);
    expect(launcher.children).toEqual([]);
  });

  it("hands the key to the runtime, gates on Anytype answering, then spawns exactly one child", async () => {
    const { subject, published, api, launcher } = await running();
    expect(published).toEqual([KEY]);
    expect(api.probes).toEqual([KEY]);
    expect(launcher.children).toHaveLength(1);
    expect(JSON.parse(launcher.envs[0]?.["OPENAPI_MCP_HEADERS"] ?? "")).toMatchObject({
      Authorization: `Bearer ${KEY}`,
    });
    expect(subject.status()).toMatchObject({ state: "ready", childPid: launcher.current.pid });
    expect(subject.session()).toBe(launcher.current.session);
  });

  it("hands the gateway the tools the ready child listed, and says each time a child is ready (WI-0018-19)", async () => {
    let readies = 0;
    const ctx = service({ onReady: () => (readies += 1) });
    expect(ctx.subject.tools()).toBeNull();
    ctx.subject.start();
    await ctx.advance(0);
    expect(ctx.subject.tools()).toEqual(TOOLS);
    expect(readies).toBe(1);
    ctx.launcher.current.exit(1);
    await ctx.advance(0);
    expect(ctx.subject.tools()).toBeNull();
    expect(ctx.subject.session()).toBeNull();
    await ctx.advance(60_000);
    expect(ctx.subject.status().state).toBe("ready");
    expect(readies).toBe(2);
  });

  it("with Anytype not running is unreachable, spawns nothing, and is not asked again on a timer", async () => {
    const ctx = service();
    ctx.api.up = false;
    ctx.subject.start();
    await ctx.advance(0);
    expect(ctx.subject.status().state).toBe("unreachable");
    expect(ctx.subject.status().detail).toContain("did not answer at http://127.0.0.1:31009");
    expect(ctx.launcher.children).toEqual([]);
    expect(ctx.subject.session()).toBeNull();
    // The shell says the launch adopted, missed or failed Anytype: one ask, no wait, told once.
    ctx.subject.checkAgain(0);
    await ctx.advance(0);
    expect(ctx.api.probes).toHaveLength(2);
    expect(ctx.notifier.notices.map((n) => n.kind)).toEqual(["anytype-unreachable"]);
    // However far the clock moves, nothing asks again: waiting changes nothing.
    ctx.api.up = true;
    await ctx.advance(600_000, 10_000);
    expect(ctx.api.probes).toHaveLength(2);
    expect(ctx.subject.status().state).toBe("unreachable");
    expect(ctx.launcher.children).toEqual([]);
    // Quit: what was said about reaching Anytype is withdrawn with the service.
    await ctx.subject.stop();
    expect(ctx.notifier.cleared).toContain("anytype-unreachable Anytype");
  });

  it("an Anytype Reload has just launched is waited for, up to 60 s, while its API comes up", async () => {
    const ctx = service();
    ctx.api.up = false;
    ctx.subject.start();
    await ctx.advance(0);
    // Quiet at start: the launch may still be under way.
    expect(ctx.notifier.notices).toEqual([]);
    // The shell: Reload launched Anytype. A longer wait asked for is held to 60 s.
    expect(await serveAnytypeCall(ctx.subject, "anytype.check", { waitMs: 600_000 })).toMatchObject(
      { ok: true },
    );
    await ctx.advance(20_000, ANYTYPE_WAIT_STEP_MS);
    expect(ctx.subject.status().state).toBe("unreachable");
    expect(ctx.notifier.notices).toEqual([]);
    ctx.api.up = true;
    await ctx.advance(1_000, ANYTYPE_WAIT_STEP_MS);
    expect(ctx.subject.status().state).toBe("ready");
    expect(ctx.notifier.notices).toEqual([]);
  });

  it("a launched Anytype that never answers is told once at the end of its 60 s, and asked no more", async () => {
    const ctx = service();
    ctx.api.up = false;
    ctx.subject.start();
    await ctx.advance(0);
    ctx.subject.checkAgain(ANYTYPE_START_WAIT_MS);
    await ctx.advance(ANYTYPE_START_WAIT_MS - 1_000, ANYTYPE_WAIT_STEP_MS);
    expect(ctx.notifier.notices).toEqual([]);
    // A plain ask meanwhile (the person comes back to the window) never cuts the wait short.
    ctx.subject.checkAgain(0);
    await ctx.advance(0);
    expect(ctx.notifier.notices).toEqual([]);
    await ctx.advance(2_000, ANYTYPE_WAIT_STEP_MS);
    expect(ctx.notifier.notices.map((n) => n.kind)).toEqual(["anytype-unreachable"]);
    const asked = ctx.api.probes.length;
    await ctx.advance(600_000, 10_000);
    expect(ctx.api.probes).toHaveLength(asked);
  });

  it("the launch wait runs on the monotonic clock: setting the wall clock forward never ends it", async () => {
    const ctx = service();
    ctx.api.up = false;
    ctx.subject.start();
    await ctx.advance(0);
    ctx.subject.checkAgain(ANYTYPE_START_WAIT_MS);
    await ctx.advance(0);
    // The wall clock jumps a day ahead; the monotonic clock (the fake's own) does not.
    const real = ctx.clock.now.bind(ctx.clock);
    Object.assign(ctx.clock, { monotonic: real, now: () => real() + 86_400_000 });
    await ctx.advance(10_000, ANYTYPE_WAIT_STEP_MS);
    expect(ctx.notifier.notices).toEqual([]);
    expect(ctx.subject.status().state).toBe("unreachable");
  });

  it("the quiet of the start ends when the shell's ask finds nothing to do: a later miss is told", async () => {
    const ctx = await running();
    expect(ctx.subject.status().state).toBe("ready");
    // The shell's ask after the launch: the child is up, so it asks nothing.
    ctx.subject.checkAgain(0);
    await ctx.advance(0);
    // Anytype goes away and the child exits: its restart finds Anytype silent, and says so.
    ctx.api.up = false;
    ctx.launcher.current.exit(1);
    await ctx.advance(250, 250);
    expect(ctx.subject.status().state).toBe("unreachable");
    expect(ctx.notifier.notices.map((n) => n.kind)).toEqual(["anytype-unreachable"]);
  });

  it("the quiet of the start ends when a key arrives: a pairing whose Anytype then goes silent is told", async () => {
    const ctx = await running({ key: null });
    expect(ctx.subject.status().state).toBe("no-key");
    await ctx.subject.startPairing();
    await ctx.subject.completePairing("1234");
    ctx.api.up = false;
    await ctx.advance(0);
    ctx.launcher.current.exit(1);
    await ctx.advance(250, 250);
    expect(ctx.subject.status().state).toBe("unreachable");
    expect(ctx.notifier.notices.map((n) => n.kind)).toEqual(["anytype-unreachable"]);
  });

  it("tells the person once, logs once per state, and asks again only when asked to", async () => {
    const ctx = service();
    ctx.api.up = false;
    ctx.subject.start();
    await ctx.advance(0);
    // The person comes back to the window twice while Anytype is still closed.
    ctx.subject.checkAgain();
    await ctx.advance(0);
    ctx.subject.checkAgain();
    await ctx.advance(0);
    expect(ctx.api.probes).toHaveLength(3);
    expect(ctx.notifier.notices).toEqual([
      {
        kind: "anytype-unreachable",
        subject: "Anytype",
        detail: "Anytype did not answer. Open the Anytype desktop app, then come back to Reload",
      },
    ]);
    const said = (state: string) =>
      ctx.logger.lines.filter((line) => line.includes(`anytype: ${state} (`)).length;
    expect(said("unreachable")).toBe(1);
    // Anytype is open now, and the person presses Check again: up, and the notice withdrawn.
    ctx.api.up = true;
    ctx.subject.checkAgain();
    await ctx.advance(0);
    expect(ctx.subject.status().state).toBe("ready");
    expect(ctx.notifier.cleared).toContain("anytype-unreachable Anytype");
    // In any other state a check asks nothing.
    ctx.subject.checkAgain();
    await ctx.advance(0);
    expect(ctx.api.probes).toHaveLength(4);
  });

  it("a start Anytype refused costs no attempt: a later crash still has the whole crash-loop budget", async () => {
    const ctx = service();
    ctx.api.up = false;
    ctx.subject.start();
    await ctx.advance(0);
    // Far more refused starts than the crash-loop limit (5 in 120 s), all inside its window.
    for (let miss = 0; miss < 10; miss += 1) {
      ctx.subject.checkAgain();
      await ctx.advance(1_000);
    }
    expect(ctx.api.probes).toHaveLength(11);
    ctx.api.up = true;
    ctx.subject.checkAgain();
    await ctx.advance(0);
    expect(ctx.subject.status().state).toBe("ready");
    // A crash is answered as a crash, after the crash backoff: four are restarted, the fifth
    // is the limit, exactly as for a child that never had a failed start.
    for (let crash = 1; crash <= 4; crash += 1) {
      ctx.launcher.current.exit(1);
      await ctx.advance(0);
      expect(ctx.subject.status().state).toBe("down");
      await ctx.advance(250 * crash, 250);
      expect(ctx.subject.status().state).toBe("ready");
    }
    ctx.launcher.current.exit(1);
    await ctx.advance(5_000);
    expect(ctx.subject.status().state).toBe("down-for-good");
    expect(ctx.launcher.children).toHaveLength(5);
  });

  it("names a tool surface that does not match, stops the child, and does not restart it", async () => {
    const ctx = service();
    const mismatch = new ToolSurfaceMismatchError({ added: ["API-new"], removed: [], changed: [] });
    ctx.launcher.prepare = (child) => {
      child.session.initializeWith = mismatch;
    };
    ctx.subject.start();
    await ctx.advance(0);
    expect(ctx.subject.status()).toMatchObject({ state: "tool-surface-mismatch", childPid: null });
    expect(ctx.subject.status().detail).toContain("added=[API-new]");
    expect(ctx.launcher.current.stops).toBe(1);
    expect(ctx.subject.session()).toBeNull();
    await ctx.advance(600_000, 10_000);
    expect(ctx.launcher.children).toHaveLength(1);
  });

  it("counts a handshake that fails some other way as a crash, and restarts after the backoff", async () => {
    const ctx = service();
    ctx.launcher.prepare = (child) => {
      child.session.initializeWith =
        ctx.launcher.children.length === 0 ? new SessionError("closed its output") : TOOLS;
    };
    ctx.subject.start();
    await ctx.advance(0);
    expect(ctx.subject.status().state).toBe("down");
    await ctx.advance(250);
    expect(ctx.subject.status().state).toBe("ready");
    expect(ctx.launcher.children).toHaveLength(2);
  });
});

describe("a dead child", () => {
  it("fails every pending call with an MCP error, retries none, and restarts under the backoff", async () => {
    const ctx = await running();
    const first = ctx.launcher.current;
    const call = ctx.subject.session()?.request("tools/call", { name: "API-create-object" });
    first.exit(1);
    await expect(call).rejects.toBeInstanceOf(SessionError);
    expect(ctx.subject.status().state).toBe("down");
    expect(ctx.subject.session()).toBeNull();
    await ctx.advance(249);
    expect(ctx.launcher.children).toHaveLength(1);
    await ctx.advance(1);
    const second = ctx.launcher.current;
    expect(second).not.toBe(first);
    expect(ctx.subject.status()).toMatchObject({ state: "ready", childPid: second.pid });
    // Not retried: the call went to the dead child once, and never to the new one.
    expect(first.session.requests).toEqual(["tools/call"]);
    expect(second.session.requests).toEqual([]);
    expect(ctx.logger.lines.join("\n")).toContain("exited on its own (code 1)");
  });

  it("stops restarting at the breaker's limit and says so in a notice", async () => {
    const ctx = await running();
    for (let exit = 1; exit <= 5; exit++) {
      ctx.launcher.current.exit(1);
      await ctx.advance(5_000);
    }
    expect(ctx.subject.status().state).toBe("down-for-good");
    expect(ctx.subject.status().detail).toContain("stopped 5 times in 120 s");
    expect(ctx.notifier.notices.map((n) => n.kind)).toEqual(["mcp-child-stopped"]);
    const launched = ctx.launcher.children.length;
    await ctx.advance(600_000, 10_000);
    expect(ctx.launcher.children).toHaveLength(launched);
  });

  it("a child stopped for good leaves the rest of the service alone: its spaces are still read", async () => {
    const ctx = await running();
    for (let exit = 1; exit <= 5; exit++) {
      ctx.launcher.current.exit(1);
      await ctx.advance(5_000);
    }
    expect(ctx.subject.status().state).toBe("down-for-good");
    ctx.api.spaces = [{ id: "s1", name: "TEST" }];
    await expect(ctx.subject.spaces(true)).resolves.toEqual([{ id: "s1", name: "TEST" }]);
  });
});

describe("a session that closes while the child lives (plan 0019)", () => {
  it("a closed session restarts the child at once", async () => {
    const ctx = await running();
    const first = ctx.launcher.current;
    const call = ctx.subject.session()?.request("tools/call", { name: "API-download-file" });
    first.session.break("the Anytype MCP child sent an oversized frame");
    // At once: the pending call fails, the live child is stopped and a notice names it, with
    // no ping asked and none missed.
    await expect(call).rejects.toThrow("oversized frame");
    expect(first.stops).toBe(1);
    expect(first.session.pings).toBe(0);
    expect(ctx.subject.session()).toBeNull();
    expect(ctx.subject.status().state).toBe("down");
    expect(ctx.notifier.notices).toHaveLength(1);
    expect(ctx.notifier.notices[0]?.kind).toBe("mcp-child-restarted");
    expect(ctx.notifier.notices[0]?.detail).toContain(`pid ${String(first.pid)}`);
    expect(ctx.notifier.notices[0]?.detail).toContain("oversized frame");
    // Under the backoff's first delay, not the heartbeat's 90 s.
    await ctx.advance(249);
    expect(ctx.launcher.children).toHaveLength(1);
    await ctx.advance(1);
    const second = ctx.launcher.current;
    expect(second).not.toBe(first);
    expect(ctx.subject.status()).toMatchObject({ state: "ready", childPid: second.pid });
    // Not retried on the new child.
    expect(second.session.requests).toEqual([]);
    // Its exit after the stop is not a second crash: four more exits reach the breaker of 5,
    // three do not.
    for (let exit = 1; exit <= 3; exit++) {
      ctx.launcher.current.exit(1);
      await ctx.advance(5_000);
    }
    expect(ctx.subject.status().state).toBe("ready");
    ctx.launcher.current.exit(1);
    await ctx.advance(5_000);
    expect(ctx.subject.status().state).toBe("down-for-good");
    expect(ctx.notifier.notices.map((n) => n.kind)).toEqual([
      "mcp-child-restarted",
      "mcp-child-stopped",
    ]);
  });

  it("restarts a child whose session broke in the handshake's last chunk, before it was ready", async () => {
    let readies = 0;
    const ctx = service({ onReady: () => (readies += 1) });
    // The session breaks after tools/list was answered, before the service hears of it.
    ctx.launcher.prepare = (child) => {
      child.session.initializeWith = TOOLS;
      const listed = child.session.initialize.bind(child.session);
      child.session.initialize = async () => {
        const tools = await listed();
        child.session.break("the Anytype MCP child sent malformed JSON");
        return tools;
      };
    };
    ctx.subject.start();
    await ctx.advance(0);
    const first = ctx.launcher.current;
    expect(first.stops).toBe(1);
    expect(ctx.subject.session()).toBeNull();
    expect(ctx.subject.status().state).toBe("down");
    expect(ctx.notifier.notices.map((n) => n.kind)).toEqual(["mcp-child-restarted"]);
    // Never ready on a closed session: not announced, not logged ready, no heartbeat started.
    expect(readies).toBe(0);
    expect(ctx.logger.lines.join("\n")).not.toContain("anytype: ready");
    ctx.launcher.prepare = (child) => {
      child.session.initializeWith = TOOLS;
    };
    await ctx.advance(249);
    expect(first.session.pings).toBe(0);
    await ctx.advance(1);
    expect(ctx.launcher.children).toHaveLength(2);
    expect(ctx.subject.status()).toMatchObject({
      state: "ready",
      childPid: ctx.launcher.current.pid,
    });
    expect(readies).toBe(1);
  });

  it("counts a session that keeps breaking against the breaker, and stops at its limit", async () => {
    const ctx = await running();
    for (let broken = 1; broken <= 5; broken++) {
      ctx.launcher.current.session.break();
      await ctx.advance(5_000);
    }
    expect(ctx.subject.status().state).toBe("down-for-good");
    expect(ctx.subject.status().detail).toContain("stopped 5 times in 120 s");
    expect(ctx.subject.status().detail).toContain("oversized frame");
    const launched = ctx.launcher.children.length;
    await ctx.advance(600_000, 10_000);
    expect(ctx.launcher.children).toHaveLength(launched);
  });

  it("leaves a child alone whose session closed because it exited, or because it was stopped", async () => {
    const ctx = await running();
    const first = ctx.launcher.current;
    first.exit(1);
    await ctx.advance(250);
    // An exit is a crash as before: no notice, logged as an exit.
    expect(ctx.notifier.notices).toEqual([]);
    expect(ctx.logger.lines.join("\n")).toContain("exited on its own (code 1)");
    const second = ctx.launcher.current;
    await ctx.subject.stop();
    second.session.break();
    await ctx.advance(60_000);
    expect(ctx.launcher.children).toHaveLength(2);
    expect(ctx.subject.status().state).toBe("stopped");
  });
});

describe("the heartbeat", () => {
  it("records beats only for pings the child answered", async () => {
    const ctx = await running();
    await ctx.advance(60_000);
    expect(ctx.subject.status().beats).toBe(3);
    ctx.launcher.current.session.pingMode = "refuse";
    await ctx.advance(60_000);
    expect(ctx.subject.status().beats).toBe(3);
  });

  it("restarts a child that stops answering but stays alive, with a notice naming it", async () => {
    const ctx = await running();
    const deaf = ctx.launcher.current;
    deaf.session.pingMode = "silent";
    for (let i = 0; i < 6 && ctx.launcher.children.length === 1; i++) {
      await ctx.advance(30_000);
      deaf.session.timeOutPings();
      await flush();
    }
    expect(deaf.stops).toBe(1);
    expect(ctx.notifier.notices).toHaveLength(1);
    expect(ctx.notifier.notices[0]?.kind).toBe("mcp-child-restarted");
    expect(ctx.notifier.notices[0]?.detail).toContain(`pid ${String(deaf.pid)}`);
    await ctx.advance(1_000);
    expect(ctx.launcher.children).toHaveLength(2);
    expect(ctx.subject.status()).toMatchObject({
      state: "ready",
      childPid: ctx.launcher.current.pid,
    });
  });

  it("leaves a child that keeps answering alone for as long as it answers", async () => {
    const ctx = await running();
    await ctx.advance(3_600_000, 30_000);
    expect(ctx.launcher.children).toHaveLength(1);
    expect(ctx.notifier.notices).toEqual([]);
  });
});

describe("the MCP child's own resource limits", () => {
  it("are the ones it declared, never the defaults: over 512 MB it is stopped and restarted, a process beside it is not", async () => {
    // 600 MB: over the 512 MB the child declared, and under the 1024 MB everything else gets.
    expect(MCP_LIMITS).toEqual({
      ...DEFAULT_LIMITS,
      memoryMb: 512,
      cpuPercent: 50,
      openFiles: 256,
    });
    const reading = (pid: number): ProcessReading => ({
      identity: { started: `started ${String(pid)}`, executable: "/node" },
      sample: { memoryMb: 600, cpuSeconds: 0, openFiles: 10, children: 0 },
      strays: [],
    });
    const passes: number[][] = [];
    const signals: string[] = [];
    // One watchdog for the services process: the child, and a process beside it under the
    // documented limits, judged in the same pass.
    let one: ResourceWatchdog | null = null;
    const ctx = service({ watchdog: (target) => (one as ResourceWatchdog)(target) });
    one = resourceWatchdog({
      probe: (pids) => {
        passes.push([...pids]);
        return Promise.resolve(new Map(pids.map((pid) => [pid, reading(pid)])));
      },
      clock: ctx.clock,
      pace: DEFAULT_WATCH_PACE,
      log: () => undefined,
      signal: (pid, signal) => signals.push(`${signal} ${String(pid)}`),
    });
    let besideStopped = 0;
    one({
      pid: 7,
      limits: DEFAULT_LIMITS,
      stop: () => (besideStopped += 1),
      kill: () => undefined,
      current: () => true,
      stopped: () => undefined,
    });
    ctx.subject.start();
    await ctx.advance(0);
    const child = ctx.launcher.current;
    expect(child.stops).toBe(0);
    await ctx.advance(90_000, 10_000);
    // Both in one read of the process table, each judged against its own line.
    expect(passes).toContainEqual([7, child.pid]);
    // Stopped through its own handle, for its own line, and started again under the breaker.
    expect(child.stops).toBe(1);
    expect(besideStopped).toBe(0);
    expect(signals).toEqual([]);
    expect(ctx.notifier.notices[0]).toMatchObject({ kind: "mcp-child-restarted" });
    expect(ctx.notifier.notices[0]?.detail).toMatch(
      new RegExp(`^It \\(pid ${String(child.pid)}\\) used memory 600 MB, over its limit of 512 MB`),
    );
    await ctx.advance(1_000);
    expect(ctx.launcher.children).toHaveLength(2);
    expect(ctx.subject.status().state).toBe("ready");
  });

  it("is not watched without a watchdog", async () => {
    const ctx = await running();
    await ctx.advance(600_000, 10_000);
    expect(ctx.launcher.children).toHaveLength(1);
  });
});

describe("pairing", () => {
  it("stores the key Anytype issues for the four-digit code, and starts the child with it", async () => {
    const ctx = await running({ key: null });
    await ctx.subject.startPairing();
    expect(ctx.subject.status().pairing).toBe(true);
    await expect(ctx.subject.completePairing("12a4")).rejects.toThrow(
      "Enter the four-digit code shown by Anytype.",
    );
    await ctx.subject.completePairing(" 1234 ");
    await ctx.advance(0);
    expect(ctx.secrets.read("anytype-api-key")).toBe(ctx.api.issuedKey);
    expect(ctx.published).toEqual([ctx.api.issuedKey]);
    expect(ctx.subject.status()).toMatchObject({ state: "ready", pairing: false });
    expect(ctx.logger.lines.join("\n")).not.toContain(ctx.api.issuedKey);
  });

  it("refuses a code before pairing was started, and a code Anytype rejects", async () => {
    const ctx = await running({ key: null });
    await expect(ctx.subject.completePairing("1234")).rejects.toThrow(/Start pairing/);
    await ctx.subject.startPairing();
    await expect(ctx.subject.completePairing("9999")).rejects.toThrow(/rejected/);
    expect(ctx.secrets.read("anytype-api-key")).toBeNull();
  });

  it("replaces a running child with one on the new key", async () => {
    const ctx = await running();
    const old = ctx.launcher.current;
    await ctx.subject.startPairing();
    await ctx.subject.completePairing("1234");
    await ctx.advance(0);
    expect(old.stops).toBe(1);
    expect(ctx.launcher.children).toHaveLength(2);
    expect(ctx.launcher.envs[1]?.["OPENAPI_MCP_HEADERS"]).toContain(ctx.api.issuedKey);
  });
});

describe("the shell's calls", () => {
  it("answers status and pairing, and turns a failure into its sentence", async () => {
    const ctx = await running({ key: null });
    expect(await serveAnytypeCall(ctx.subject, "anytype.status", null)).toMatchObject({
      ok: true,
      value: { state: "no-key" },
    });
    expect(await serveAnytypeCall(ctx.subject, "anytype.check", null)).toMatchObject({
      ok: true,
      value: { state: "no-key" },
    });
    expect(await serveAnytypeCall(ctx.subject, "anytype.pair.start", null)).toMatchObject({
      ok: true,
      value: { pairing: true },
    });
    expect(await serveAnytypeCall(ctx.subject, "anytype.pair.complete", "12")).toEqual({
      ok: false,
      error: "Enter the four-digit code shown by Anytype.",
    });
    expect(await serveAnytypeCall(ctx.subject, "anytype.pair.complete", "1234")).toMatchObject({
      ok: true,
    });
    expect(await serveAnytypeCall(ctx.subject, "view.get", null)).toMatchObject({ ok: false });
  });
});

describe("stop", () => {
  it("stops the child and restarts nothing afterwards", async () => {
    const ctx = await running();
    const child = ctx.launcher.current;
    await ctx.subject.stop();
    expect(child.stops).toBe(1);
    expect(ctx.subject.status()).toMatchObject({ state: "stopped", childPid: null });
    await ctx.advance(60_000);
    expect(ctx.launcher.children).toHaveLength(1);
  });

  it("stops a service waiting on Anytype without ever starting a child", async () => {
    const ctx = service();
    ctx.api.up = false;
    ctx.subject.start();
    await ctx.advance(0);
    await ctx.subject.stop();
    ctx.api.up = true;
    await ctx.advance(60_000);
    expect(ctx.launcher.children).toEqual([]);
  });
});
