// The shell's telemetry (WI-0018-22, plan 0029): crash reports that count the runtime's, the
// services process's and every node process's crashes, app_start once the children are up, the
// launch marker that tells an unclean stop, the first-run steps told once, the provider events,
// the page's question and switch over IPC, and the children's facts reaching the shell over the
// channel.
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { CrashReports } from "../../src/application/crash-reports";
import { shellNodeCrashes, shellSignals } from "../../src/application/serve-shell";
import { parseChildMessage, parseChildSignal } from "../../src/domain/channel/messages";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import type { ChildSignal, Versions } from "../../src/domain/telemetry/reports";
import { IPC } from "../../src/shell/ipc";
import {
  reportedPackages,
  telemetryEndpoints,
  wireTelemetry,
  type ListedPackage,
  type TelemetryWiring,
} from "../../src/shell/telemetry";
import type { TelemetryStatus } from "../../src/ui/contract";
import { exitsAtOnce, obedient, RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { supervised } from "../fakes/supervised";
import {
  MemoryMarks,
  MemoryQueue,
  MemorySetting,
  RecordingPoster,
  settle,
} from "../fakes/telemetry";

const VERSIONS: Versions = { appVersion: "1.0.0", os: "linux", osVersion: "6.8", arch: "x64" };

const status = (child: ChildStatus["child"], state: ChildStatus["state"]): ChildStatus => ({
  child,
  state,
  generation: 1,
  pid: null,
  port: null,
  error: null,
});

/** A supervisor as far as telemetry listens to it. */
class ListenedSupervisor {
  statusListeners: ((status: ChildStatus) => void)[] = [];
  nodeListeners: ((stopped: boolean) => void)[] = [];
  signalListeners: ((signal: ChildSignal) => void)[] = [];
  onStatus(listener: (status: ChildStatus) => void): void {
    this.statusListeners.push(listener);
  }
  onSignal(listener: (signal: ChildSignal) => void): void {
    this.signalListeners.push(listener);
  }
  tell(signal: ChildSignal): void {
    for (const listener of this.signalListeners) {
      listener(signal);
    }
  }
  onNodeCrash(listener: (stopped: boolean) => void): void {
    this.nodeListeners.push(listener);
  }
  publish(value: ChildStatus): void {
    for (const listener of this.statusListeners) {
      listener(value);
    }
  }
}

const PACKAGES: ListedPackage[] = [
  { name: "anytype", document: { version: "1.2.0" }, installed: false, signed: false },
  { name: "probekit", document: { version: "0.3.0" }, installed: true, signed: true },
  { name: "my-private-thing", document: { version: "0.0.1" }, installed: true, signed: false },
  { name: "odd", document: null, installed: true, signed: true },
];

/** Test servers, so that no test here reports to the endpoints a release is built with. */
const TEST_ENV = {
  RELOAD_GLITCHTIP_DSN: "https://key@glitchtip.test/1",
  RELOAD_UMAMI_URL: "https://umami.test",
  RELOAD_UMAMI_WEBSITE_ID: "site",
};

function wired(
  answer: "on" | "off" | "unset",
  env: Readonly<Record<string, string | undefined>> = TEST_ENV,
  marks = new MemoryMarks(),
) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const setting = new MemorySetting(answer);
  const queue = new MemoryQueue();
  const poster = new RecordingPoster();
  const clock = new FakeClock();
  const runtime = new ListenedSupervisor();
  const services = new ListenedSupervisor();
  let identified = 0;
  const deps: TelemetryWiring = {
    ipc: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as TelemetryWiring["ipc"],
    setting,
    queue,
    poster,
    machineIdentifier: () => {
      identified += 1;
      return "RAW-MACHINE-IDENTIFIER-0001";
    },
    hashIdentifier: () => "f".repeat(64),
    clock,
    logger: new RecordingLogger(),
    built: packageJson.reload,
    env,
    appVersion: "1.0.0",
    registry: { redact: (text) => text },
    sink: { protect: () => undefined },
    supervisors: new Map([
      ["runtime", runtime],
      ["services", services],
    ]),
    packages: () => PACKAGES,
    marks,
    uptimeMs: () => 4_500,
  };
  const telemetry = wireTelemetry(deps);
  const { pipeline } = telemetry;
  const call = (channel: string, ...args: unknown[]): TelemetryStatus =>
    handlers.get(channel)?.({}, ...args) as TelemetryStatus;
  /** Both children running: the launch is up. */
  const up = (): void => {
    runtime.publish(status("runtime", "running"));
    services.publish(status("services", "running"));
  };
  /** The queued usage events' names, in order. */
  const events = (): unknown[] =>
    queue.reports.filter((report) => report.kind === "usage").map((r) => r.payload["event"]);
  return {
    telemetry,
    pipeline,
    marks,
    up,
    events,
    setting,
    queue,
    poster,
    clock,
    runtime,
    services,
    call,
    identified: () => identified,
  };
}

describe("the shell's telemetry", () => {
  it("nothing is reported while the telemetry question is unanswered", async () => {
    const world = wired("unset");
    world.runtime.publish(status("runtime", "down"));
    world.services.publish(status("services", "down-for-good"));
    for (const listener of world.runtime.nodeListeners) {
      listener(false);
    }
    world.clock.advance(60_000);
    await settle();
    expect(world.queue.reports).toEqual([]);
    expect(world.poster.sent).toEqual([]);
    expect(world.identified()).toBe(0);
  });

  it("the question is asked, and answers nothing yet", () => {
    const world = wired("unset");
    const asked = world.call(IPC.telemetry);
    expect(asked.answer).toBe("unset");
    // A call that is not an answer answers nothing.
    expect(world.call(IPC.setTelemetry, "yes").answer).toBe("unset");
    expect(world.setting.answer).toBe("unset");
  });

  it.each([
    ["Yes", true, "on"],
    ["No", false, "off"],
  ] as const)("answering the question %s records the answer and closes it", (_, on, stored) => {
    const world = wired("unset");
    expect(world.call(IPC.setTelemetry, on).answer).toBe(stored);
    expect(world.setting.answer).toBe(stored);
    expect(world.call(IPC.telemetry).answer).toBe(stored);
  });

  it("a yes is what lets app_start be queued, naming only shipped and signed packages", () => {
    const world = wired("unset");
    world.up();
    expect(world.queue.reports).toEqual([]);
    world.call(IPC.setTelemetry, true);
    expect(world.events()).toEqual(["app_start", "setup_step"]);
    expect(world.queue.reports[0]?.payload).toMatchObject({
      event: "app_start",
      startup_ms: 4_500,
      first_launch: true,
      packages: [
        { id: "anytype", version: "1.2.0" },
        { id: "probekit", version: "0.3.0" },
        { id: "odd", version: "unknown" },
      ],
      unsigned_packages: 1,
    });
    expect(JSON.stringify(world.queue.reports)).not.toContain("my-private-thing");
  });

  it("app_start waits for both children, and is queued once a launch", () => {
    const world = wired("on");
    expect(world.events()).toEqual(["setup_step"]);
    world.runtime.publish(status("runtime", "running"));
    expect(world.events()).toEqual(["setup_step"]);
    world.services.publish(status("services", "running"));
    world.up();
    world.call(IPC.setTelemetry, true);
    expect(world.events()).toEqual(["setup_step", "app_start"]);
    expect(world.call(IPC.telemetry).queued).toBe(2);
  });

  it("crash reports cover the runtime, the services process and node processes, with counts", () => {
    const world = wired("on");
    world.runtime.publish(status("runtime", "running"));
    world.queue.purge();
    world.runtime.publish(status("runtime", "down"));
    world.services.publish(status("services", "down-for-good"));
    for (const listener of world.runtime.nodeListeners) {
      listener(false);
      listener(true);
    }
    const crashes = world.queue.reports.map((report) => report.payload);
    expect(crashes.map((payload) => [payload["crashed"], payload["stopped_for_good"]])).toEqual([
      ["runtime", false],
      ["services", true],
      ["node", false],
      ["node", true],
    ]);
    expect(crashes.at(-1)?.["crashes"]).toEqual({
      runtime: 1,
      services: 1,
      node: 2,
      node_stopped: 1,
    });
    expect(crashes.every((payload) => payload["kind"] === "error")).toBe(true);
  });

  it("turning telemetry off in the window empties the queue", () => {
    const world = wired("on");
    world.runtime.publish(status("runtime", "down"));
    expect(world.queue.reports).toHaveLength(2);
    expect(world.call(IPC.setTelemetry, false)).toMatchObject({ answer: "off", queued: 0 });
    world.up();
    expect(world.queue.reports).toEqual([]);
    expect(world.queue.reports).toEqual([]);
  });

  it("See what would be sent answers the queued reports in full, and nothing once off", () => {
    const world = wired("on");
    world.runtime.publish(status("runtime", "down"));
    const shown = world.call(IPC.telemetryReports) as unknown as readonly {
      kind: string;
      payload: Record<string, unknown>;
    }[];
    expect(shown).toEqual(
      world.queue.reports.map((report) => ({ kind: report.kind, payload: report.payload })),
    );
    expect(shown.map((report) => report.kind)).toEqual(["usage", "error"]);
    world.call(IPC.setTelemetry, false);
    expect(world.call(IPC.telemetryReports)).toEqual([]);
  });

  it("the build's endpoints are Umami Cloud and no GlitchTip, unless the environment says else", () => {
    const built = packageJson.reload;
    expect(telemetryEndpoints({}, built)).toEqual({
      glitchtipDsn: "",
      umamiUrl: "https://cloud.umami.is",
      umamiWebsiteId: "edce25fe-ad86-4241-b0e1-87f456cc3dfa",
    });
    expect(telemetryEndpoints(TEST_ENV, built)).toEqual({
      glitchtipDsn: "https://key@glitchtip.test/1",
      umamiUrl: "https://umami.test",
      umamiWebsiteId: "site",
    });
    expect(reportedPackages([])).toEqual({ named: [], unsigned: 0 });
  });

  it("with the build's endpoints, nothing is posted before consent and one batch of usage events after", async () => {
    // The release's own endpoints, unoverridden; the poster records, so nothing leaves this test.
    const world = wired("unset", {});
    world.runtime.publish(status("runtime", "down"));
    world.up();
    world.clock.advance(60_000);
    await settle();
    expect(world.poster.sent).toEqual([]);

    world.call(IPC.setTelemetry, true);
    world.clock.advance(60_000);
    await settle();
    expect(world.poster.sent).toHaveLength(1);
    const [sent] = world.poster.sent;
    expect(sent?.url).toBe("https://cloud.umami.is/api/batch");
    const body = JSON.parse(sent?.body ?? "[]") as {
      type: string;
      payload: { website: string; name: string };
    }[];
    expect(body.map((event) => event.type)).toEqual(["event", "event"]);
    expect(body.map((event) => event.payload.website)).toEqual([
      "edce25fe-ad86-4241-b0e1-87f456cc3dfa",
      "edce25fe-ad86-4241-b0e1-87f456cc3dfa",
    ]);
    expect(body.map((event) => event.payload.name)).toEqual(["app_start", "setup_step"]);
    // The runtime crashing again is queued, but there is no GlitchTip to send it to.
    world.runtime.publish(status("runtime", "down"));
    world.clock.advance(60_000);
    await settle();
    expect(world.poster.sent).toHaveLength(1);
  });
});

describe("the launch's own signals (plan 0029)", () => {
  const payloads = (world: ReturnType<typeof wired>, event: string) =>
    world.queue.reports
      .map((report) => report.payload)
      .filter((payload) => payload["event"] === event);

  it("a killed launch leaves its marker, and the next launch tells app_unclean_stop", () => {
    const marks = new MemoryMarks();
    const first = wired("on", TEST_ENV, marks);
    expect(marks.running).toBe("1.0.0");
    expect(payloads(first, "app_unclean_stop")).toEqual([]);
    // Killed: no stopping() ran, so the marker stays.
    const second = wired("on", TEST_ENV, marks);
    expect(payloads(second, "app_unclean_stop")).toEqual([
      expect.objectContaining({ last_version: "1.0.0", app_version: "1.0.0" }),
    ]);
    // A clean quit: app_stop queued, the marker gone, and the next start tells nothing unclean.
    second.telemetry.stopping("update");
    expect(payloads(second, "app_stop")).toEqual([
      expect.objectContaining({ uptime_s: 5, reason: "update" }),
    ]);
    expect(marks.running).toBeNull();
    const third = wired("on", TEST_ENV, marks);
    expect(payloads(third, "app_unclean_stop")).toEqual([]);
  });

  it("app_stop clears the marker even when the switch keeps the event", () => {
    const marks = new MemoryMarks();
    const world = wired("off", TEST_ENV, marks);
    world.telemetry.stopping("quit");
    expect(world.queue.reports).toEqual([]);
    expect(marks.running).toBeNull();
  });

  it("first_launch is true only before any launch was remembered", () => {
    const marks = new MemoryMarks();
    const first = wired("on", TEST_ENV, marks);
    first.up();
    expect(payloads(first, "app_start")[0]?.["first_launch"]).toBe(true);
    const second = wired("on", TEST_ENV, marks);
    second.up();
    expect(payloads(second, "app_start")[0]?.["first_launch"]).toBe(false);
  });

  it("each first-run step is told once, and a step reached before the yes is told at it", () => {
    const marks = new MemoryMarks();
    const world = wired("unset", TEST_ENV, marks);
    world.telemetry.reached("anytype_paired");
    expect(world.queue.reports).toEqual([]);
    expect(marks.memory?.reached).toEqual(["launched", "anytype_paired"]);
    world.call(IPC.setTelemetry, true);
    expect(payloads(world, "setup_step").map((payload) => payload["step"])).toEqual([
      "launched",
      "anytype_paired",
    ]);
    world.telemetry.reached("anytype_paired");
    world.runtime.tell({ kind: "deployed", nodesPerFlow: [0], perPackage: [] });
    world.runtime.tell({
      kind: "deployed",
      nodesPerFlow: [2, 1],
      perPackage: [{ package: "probekit", nodes: 3 }],
    });
    world.runtime.tell({ kind: "deployed", nodesPerFlow: [4], perPackage: [] });
    expect(payloads(world, "setup_step").map((payload) => payload["step"])).toEqual([
      "launched",
      "anytype_paired",
      "first_flow_deployed",
    ]);
    // The next launch remembers them all as told.
    const next = wired("on", TEST_ENV, marks);
    expect(payloads(next, "setup_step")).toEqual([]);
  });

  it("a provider is registered when first seen and removed when gone, its URL sent as its host", () => {
    const marks = new MemoryMarks();
    const world = wired("on", TEST_ENV, marks);
    const official = {
      name: "official",
      url: "https://catalogue.recircu.it/v1/index.json",
      official: true,
      publicKey: "RWfake-public-key",
      offered: 4,
    };
    const mine = {
      name: "mine",
      url: "https://fakeuser:fakepass-W3e4R5@packages.example/c?token=fakeQueryTok9Z8Y7X6W5V4U3T2S",
      official: false,
      publicKey: null,
      offered: 2,
    };
    world.telemetry.providers([official, mine]);
    world.telemetry.providers([official, mine]);
    expect(payloads(world, "provider_registered")).toEqual([
      expect.objectContaining({
        provider_host: "catalogue.recircu.it",
        official: true,
        signer_fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown,
        packages_offered: 4,
      }),
      expect.objectContaining({
        provider_host: "packages.example",
        official: false,
        signer_fingerprint: null,
        packages_offered: 2,
      }),
    ]);
    world.telemetry.providers([official]);
    expect(payloads(world, "provider_removed")).toEqual([
      expect.objectContaining({ provider_host: "packages.example", official: false }),
    ]);
    const sent = JSON.stringify(world.queue.reports);
    for (const leak of ["fakeuser", "fakepass", "fakeQueryTok", "RWfake", "/c?", "index.json"]) {
      expect(sent).not.toContain(leak);
    }
    // The memory on disk keeps each provider's host, never its address.
    expect(marks.memory?.providers).toEqual({
      official: { host: "catalogue.recircu.it", official: true },
    });
    world.telemetry.providers([official, mine]);
    const remembered = JSON.stringify(marks.memory);
    expect(remembered).toContain("packages.example");
    for (const leak of ["fakeuser", "fakepass", "fakeQueryTok", "https:", "/c"]) {
      expect(remembered).not.toContain(leak);
    }
  });

  it("package and update signals the shell's other parts build are queued with the version fields", () => {
    const world = wired("on");
    world.telemetry.signal({
      name: "update_offered",
      fields: { from_version: "1.0.0", to_version: "1.1.0", channel: "latest" },
    });
    expect(payloads(world, "update_offered")).toEqual([
      expect.objectContaining({ to_version: "1.1.0", app_version: "1.0.0", os: process.platform }),
    ]);
  });

  it("a child's facts become package_used, package_error, mcp_call and flow_deployed", () => {
    const world = wired("on");
    const step = { nodeKind: "node" as const, nodeId: "probe", durationMs: 12.4, ok: true };
    world.runtime.tell({ kind: "step", package: "probekit", step, failure: null });
    world.runtime.tell({
      kind: "step",
      package: "probekit",
      step: { ...step, ok: false },
      failure: { errorType: "ValueError", file: "src/probe.py", line: 7 },
    });
    world.runtime.tell({
      kind: "step",
      package: "my-private-thing",
      step: { ...step, nodeId: "secret-type", ok: false },
      failure: { errorType: "Error", file: "lib/mine.js", line: 3 },
    });
    world.runtime.tell({
      kind: "step",
      package: "anytype",
      step: { ...step, ok: false },
      failure: null,
    });
    world.services.tell({
      kind: "mcp-call",
      call: {
        tool: "API-list-spaces",
        client: "claude-ai",
        durationMs: 30,
        ok: true,
        errorCode: null,
      },
    });
    world.runtime.tell({
      kind: "deployed",
      nodesPerFlow: [3, 2],
      perPackage: [
        { package: "probekit", nodes: 2 },
        { package: "my-private-thing", nodes: 1 },
        { package: "gone-meanwhile", nodes: 1 },
        { package: "node-red", nodes: 1 },
      ],
    });
    expect(payloads(world, "package_used")).toEqual([
      expect.objectContaining({
        package: "probekit",
        version: "0.3.0",
        source: "catalogue",
        signed: true,
        node_id: "probe",
        duration_ms: 12,
        ok: true,
      }),
      expect.objectContaining({ package: "probekit", ok: false }),
      expect.objectContaining({ package: "unsigned", version: null, node_id: null, ok: false }),
      expect.objectContaining({ package: "anytype", source: "shipped", signed: true, ok: false }),
    ]);
    expect(payloads(world, "package_error")).toEqual([
      expect.objectContaining({
        package: "probekit",
        error_type: "ValueError",
        file: "src/probe.py",
        line: 7,
      }),
      expect.objectContaining({ package: "unsigned", error_type: "Error", file: null, line: 3 }),
      expect.objectContaining({
        package: "anytype",
        error_type: null,
        file: null,
        line: null,
      }),
    ]);
    for (const payload of payloads(world, "package_error")) {
      expect(Object.keys(payload)).not.toContain("error");
    }
    expect(payloads(world, "mcp_call")).toEqual([
      expect.objectContaining({
        package: "reload_anytype",
        version: null,
        tool: "api-list-spaces",
        client: "claude-ai",
        ok: true,
        error_code: null,
      }),
    ]);
    expect(payloads(world, "flow_deployed")).toEqual([
      expect.objectContaining({
        flows: 2,
        nodes: 5,
        nodes_per_flow: [3, 2],
        nodes_per_package: [
          { package: "probekit", nodes: 2 },
          { package: "unsigned", nodes: 2 },
          { package: "node-red", nodes: 1 },
        ],
      }),
    ]);
    expect(JSON.stringify(world.queue.reports)).not.toMatch(
      /my-private-thing|secret-type|lib\/mine/,
    );
  });
});

describe("crash counts", () => {
  it("counts each crash once and hands every report the counts so far", () => {
    const recorded: Readonly<Record<string, unknown>>[] = [];
    const reports = new CrashReports({
      record: (payload) => recorded.push(payload),
      versions: VERSIONS,
    });
    reports.childStatus(status("runtime", "starting"));
    reports.childStatus(status("runtime", "down"));
    reports.childStatus(status("runtime", "recovering"));
    reports.nodeCrashed(true);
    expect(reports.counts()).toEqual({ runtime: 1, services: 0, node: 1, nodeStopped: 1 });
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({
      exception_type: "NodeProcessCrashed",
      app_version: "1.0.0",
    });
  });
});

describe("a child's facts reach the shell over the channel (plan 0029)", () => {
  it("the child posts them, the channel checks them, and the supervisor tells its listeners", () => {
    const posted: unknown[] = [];
    const link = { post: (message: unknown) => posted.push(message) };
    const signal: ChildSignal = {
      kind: "step",
      package: "probekit",
      step: { nodeKind: "view", nodeId: "probe", durationMs: 3, ok: false },
      failure: { errorType: "Error", file: "a.js", line: 2 },
    };
    shellSignals(link as unknown as Parameters<typeof shellSignals>[0])(signal);
    expect(posted).toEqual([{ v: 1, t: "signal", signal }]);
    expect(parseChildMessage(posted[0])).toEqual({ v: 1, t: "signal", signal });

    const { supervisor, launcher } = supervised(obedient);
    const heard: ChildSignal[] = [];
    supervisor.onSignal((value) => heard.push(value));
    supervisor.start();
    launcher.current.send({ v: 1, t: "signal", signal });
    expect(heard).toEqual([signal]);
  });

  it("every kind of fact is checked: a malformed one is no message at all", () => {
    const valid: ChildSignal[] = [
      {
        kind: "step",
        package: "p",
        step: { nodeKind: "source", nodeId: "t", durationMs: 1, ok: true },
        failure: null,
      },
      {
        kind: "mcp-call",
        call: { tool: null, client: null, durationMs: 1, ok: false, errorCode: -32602 },
      },
      { kind: "deployed", nodesPerFlow: [1, 0], perPackage: [{ package: "p", nodes: 1 }] },
    ];
    for (const signal of valid) {
      expect(parseChildSignal(signal)).toEqual(signal);
    }
    // A failure's fields of the wrong shape are null, never a refusal of the step.
    expect(
      parseChildSignal({
        ...valid[0],
        failure: { errorType: 7, message: "m", file: "f".repeat(2001), line: -1 },
      }),
    ).toEqual({ ...valid[0], failure: { errorType: null, file: null, line: null } });
    for (const bad of [
      null,
      "step",
      { kind: "other" },
      { ...valid[0], package: 3 },
      { ...valid[0], step: null },
      { ...valid[0], step: { nodeKind: "x", nodeId: "t", durationMs: 1, ok: true } },
      { ...valid[0], step: { nodeKind: "node", nodeId: 1, durationMs: 1, ok: true } },
      { ...valid[0], step: { nodeKind: "node", nodeId: "t", durationMs: "1", ok: true } },
      { ...valid[0], step: { nodeKind: "node", nodeId: "t", durationMs: 1, ok: "yes" } },
      { kind: "mcp-call", call: null },
      { kind: "mcp-call", call: { durationMs: "1", ok: true, errorCode: null } },
      { kind: "mcp-call", call: { durationMs: 1, ok: 1, errorCode: null } },
      { kind: "mcp-call", call: { durationMs: 1, ok: true, errorCode: 1.5 } },
      { kind: "deployed", nodesPerFlow: "1", perPackage: [] },
      { kind: "deployed", nodesPerFlow: [-1], perPackage: [] },
      { kind: "deployed", nodesPerFlow: [1], perPackage: {} },
      { kind: "deployed", nodesPerFlow: [1], perPackage: [{ package: 1, nodes: 1 }] },
      { kind: "deployed", nodesPerFlow: [1], perPackage: [{ package: "p", nodes: 0.5 }] },
    ]) {
      expect(parseChildSignal(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseChildMessage({ v: 1, t: "signal", signal: { kind: "other" } })).toBeNull();
  });
});

describe("a node's crash reaches the shell over the channel", () => {
  it("the runtime posts it, the channel parses it, and the supervisor tells its listeners", () => {
    const posted: unknown[] = [];
    const link = { post: (message: unknown) => posted.push(message) };
    shellNodeCrashes(link as unknown as Parameters<typeof shellNodeCrashes>[0]).nodeCrashed(true);
    expect(posted).toEqual([{ v: 1, t: "node-crash", stopped: true }]);
    expect(parseChildMessage(posted[0])).toEqual({ v: 1, t: "node-crash", stopped: true });
    expect(parseChildMessage({ v: 1, t: "node-crash", stopped: "yes" })).toBeNull();

    const { supervisor, launcher } = supervised(obedient);
    const heard: boolean[] = [];
    supervisor.onNodeCrash((stopped) => heard.push(stopped));
    supervisor.start();
    launcher.current.send({ v: 1, t: "node-crash", stopped: false });
    expect(heard).toEqual([false]);
  });

  it("a real supervisor's crash loop is counted crash by crash, to the limit", () => {
    const { supervisor, clock } = supervised(exitsAtOnce);
    const recorded: Readonly<Record<string, unknown>>[] = [];
    const reports = new CrashReports({
      record: (payload) => recorded.push(payload),
      versions: VERSIONS,
    });
    supervisor.onStatus((value) => {
      reports.childStatus(value);
    });
    supervisor.start();
    clock.advance(60_000);
    // The crash-loop limit (5 in 2 minutes): four restarts, then down for good.
    expect(reports.counts().runtime).toBe(5);
    expect(recorded.map((payload) => payload["stopped_for_good"])).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});
