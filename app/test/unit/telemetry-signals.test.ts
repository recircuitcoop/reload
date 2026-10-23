// The pieces of plan 0029's signals that stand on their own: the builders' rules for what a field
// may hold, a deploy's exact counts, the providers a listing sees, the redaction's vouched fields,
// Umami's batch request, the pipeline's draining in batches, and the launch marker on disk.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsTelemetryMarks } from "../../src/adapters/telemetry/marks";
import { CORE_NODES, deployCounts } from "../../src/application/flows";
import { PackageCatalogues, type CatalogueReads } from "../../src/application/package-catalogues";
import { TelemetryPipeline } from "../../src/application/telemetry";
import { factsOf } from "../../src/application/usage-signals";
import { REDACTED } from "../../src/domain/redaction/registry";
import { redactPayload } from "../../src/domain/telemetry/redact";
import { WITHHELD } from "../../src/domain/telemetry/redact";
import {
  appUncleanStop,
  flowDeployed,
  lineOf,
  mcpCall,
  packageInstallFailed,
  packagePresent,
  packageUpdated,
  packageUsed,
  providerRegistered,
  providerRemoved,
  updateSignal,
  versionFields,
  VOUCHED_FIELDS,
  type QueuedReport,
} from "../../src/domain/telemetry/reports";
import {
  clientOf,
  errorCodeOf,
  errorTypeOf,
  OTHER,
  RULES_VERSION,
  stepFile,
} from "../../src/domain/telemetry/vocabulary";
import { releaseOf } from "../../src/shell/telemetry";
import { MAX_BATCH, outgoingFor } from "../../src/domain/telemetry/transports";
import { RecordingLogger } from "../fakes/children";
import { ENDPOINTS, settle, telemetryWorld } from "../fakes/telemetry";

describe("what a field may hold (plan 0029)", () => {
  it("a step's file is a plain source path inside its package, withheld otherwise", () => {
    expect(stepFile("src/node.py")).toBe("src/node.py");
    expect(stepFile("dist/anytype.cjs")).toBe("dist/anytype.cjs");
    expect(stepFile("src/reload_node/__init__.py")).toBe("src/reload_node/__init__.py");
    expect(stepFile(null)).toBeNull();
    for (const bad of [
      "/Users/fake-person/node.py",
      "../outside.py",
      "src/../../x.py",
      "./node.py",
      "C:\\\\node.py",
      "a b.py",
      "src/notes.md",
      // A dotted, key-like segment: Anytype's keys may hold dots (KEY_SHAPE).
      "src/fake.Qw9x.Zr7L.mK2p/node.py",
      "src/fake.Qw9x.Zr7L.py",
      "src/kéy/node.py",
      `${"x".repeat(197)}.py`,
      7,
    ]) {
      expect(stepFile(bad), String(bad)).toBe(WITHHELD);
    }
  });

  it("an error type is a standard one or `other`; a client a known app or `other`", () => {
    for (const known of ["ZeroDivisionError", "TypeError", "ECONNREFUSED", "KeyError"]) {
      expect(errorTypeOf(known)).toBe(known);
    }
    // A package's own class is its author's word: never sent, whatever its form.
    for (const own of [
      "InputProblem",
      "sk_live_abc123",
      "Ab3dEf6hIj9kLm2$nOp5qRs8tUv1wXy$Z0aB2cD4eF6gH8i$J1kL3mN5oP7q",
      "AbCdEfGhIjKlMnOpQrStUvW",
      "Pin12345678",
      3,
    ]) {
      expect(errorTypeOf(own), String(own)).toBe(OTHER);
    }
    expect(errorTypeOf(undefined)).toBeNull();
    expect(lineOf(12)).toBe(12);
    for (const bad of [0, -1, 1.5, "3", 10_000_001]) {
      expect(lineOf(bad)).toBeNull();
    }
    expect(clientOf("claude-ai")).toBe("claude");
    expect(clientOf(" Visual Studio Code ")).toBe("vscode");
    expect(clientOf("cursor-vscode")).toBe("cursor");
    for (const other of ["bob hunter2", "Ab3dEf6hIj9kLm2 nOp5qRs8tUv1wXy", "cursor ×4 sk-Ab12"]) {
      expect(clientOf(other), other).toBe(OTHER);
    }
    expect(clientOf(null)).toBeNull();
  });

  it("an error code is JSON-RPC's reserved range or an HTTP-like status, else withheld", () => {
    for (const code of [-32700, -32602, -32000, -32768, 404, 100, 599]) {
      expect(errorCodeOf(code)).toBe(code);
    }
    for (const code of [4111111111111111, -31999, 600, 99, 1.5, 0]) {
      expect(errorCodeOf(code), String(code)).toBe(WITHHELD);
    }
    expect(errorCodeOf(null)).toBeNull();
  });

  it("every version is MAJOR.MINOR.PATCH with at most an alpha, beta or rc number", () => {
    expect(
      versionFields({ appVersion: "0.4.0", os: "linux", osVersion: "6.8.0", arch: "x64" }),
    ).toEqual({ app_version: "0.4.0", os: "linux", os_version: "6.8.0", arch: "x64" });
    expect(
      versionFields({ appVersion: "pass=x", os: "a b", osVersion: "bob:hunter2", arch: "" }),
    ).toEqual({ app_version: WITHHELD, os: OTHER, os_version: WITHHELD, arch: OTHER });
    for (const bad of [
      "1.0.0-Ab3d.Ef6h.Ij9k.Lm2n.Op5q.Rs8t",
      "1.0.0+Ab3dEf6hIj9kLm2.nOp5qRs8tUv1wXy",
      "1.0.0-beta.x",
      "12345678.0.0",
      "1.0",
      "unknown",
    ]) {
      expect(appUncleanStop(bad).fields["last_version"], bad).toBe(WITHHELD);
    }
    expect(updateSignal("update_offered", "1.0.0", "2.0.0-beta.1", "beta").fields).toEqual({
      from_version: "1.0.0",
      to_version: "2.0.0-beta.1",
      channel: "beta",
    });
    // The OS's own release, read off its leading numbers.
    expect(releaseOf("6.8.0-45-generic")).toBe("6.8.0");
    expect(releaseOf("25.3.0")).toBe("25.3.0");
    expect(releaseOf("10.0")).toBe("10.0.0");
    expect(releaseOf("weird")).toBe("unknown");
  });

  it("a provider's host is sent only for Reload's own catalogue: any other is `custom`", () => {
    const facts = (url: string, official = false) => ({ url, official });
    expect(providerRegistered(facts("file:///Users/x/c.json"), null, 0).fields).toMatchObject({
      provider_host: "file",
      signer_fingerprint: null,
    });
    expect(providerRegistered(facts("not a url"), "NOT-HEX", 1).fields).toMatchObject({
      provider_host: "custom",
      signer_fingerprint: null,
    });
    expect(
      providerRegistered(
        facts("https://a1b2c3d4e5f6g7h.i8j9k0l1m2n3o4p.q5r6s7t8u9v0w1x.example.com/c.json"),
        null,
        0,
      ).fields["provider_host"],
    ).toBe("custom");
    expect(
      providerRegistered(facts("https://catalogue.recircu.it/v1/index.json", true), null, 0).fields[
        "provider_host"
      ],
    ).toBe("catalogue.recircu.it");
    expect(providerRemoved({ host: "a.example", official: false }, "c.example").fields).toEqual({
      provider_host: "custom",
      official: false,
    });
    // The memory on disk says official, but only the build's own host is ever sent.
    expect(
      providerRemoved({ host: "alice-smith.example", official: true }, "c.example").fields,
    ).toMatchObject({ provider_host: "custom" });
    expect(providerRemoved({ host: "c.example", official: true }, "c.example").fields).toEqual({
      provider_host: "c.example",
      official: true,
    });
  });

  it("a refusal is its code, never its words; a tool name is lowercased", () => {
    const where = { kind: "catalogue" as const, url: null, official: false };
    expect(packageInstallFailed(where, "download-failed").fields["reason"]).toBe("download-failed");
    expect(packageInstallFailed(where, "the server said no").fields["reason"]).toBe("other");
    expect(packageInstallFailed(where, "x").fields["provider_host"]).toBeNull();
    expect(
      packageInstallFailed({ ...where, url: "https://mine.example/c.json" }, "x").fields[
        "provider_host"
      ],
    ).toBe("custom");
    const call = {
      method: "tools/call" as const,
      tool: "API-get-collection-views",
      client: null,
      durationMs: -3,
      ok: true,
      errorCode: null,
    };
    expect(mcpCall("1.0.0", call).fields).toMatchObject({
      tool: "api-get-collection-views",
      duration_ms: 0,
    });
    expect(mcpCall(null, { ...call, tool: null }).fields["tool"]).toBeNull();
    expect(
      mcpCall("1.0.0", { ...call, method: "resources/read", tool: null }).fields,
    ).toMatchObject({ method: "resources/read", tool: null, package: "reload_anytype" });
  });

  it("a step's node_id is named only when the signed package declares that type", () => {
    const facts = {
      package: "probekit",
      version: "0.3.0",
      source: "catalogue" as const,
      signed: true,
      environment: null,
      nodeTypes: ["probe"],
    };
    const step = (nodeId: string) => ({
      nodeKind: "node" as const,
      nodeId,
      durationMs: 1,
      ok: true,
    });
    expect(packageUsed(facts, step("probe")).fields["node_id"]).toBe("probe");
    for (const made of ["zqxjkvbwplmn-rtyhgfdsaqwe-rtyuiopasdfgh", "AbCdEfGhIjKlMnOpQrStUvW"]) {
      expect(packageUsed(facts, step(made)).fields["node_id"], made).toBe("unsigned");
    }
    expect(packagePresent(facts).fields).toEqual({
      package: "probekit",
      version: "0.3.0",
      source: "catalogue",
      signed: true,
      environment: null,
    });
  });

  it("an unsigned package's update names no version it came from", () => {
    const facts = {
      package: "mine",
      version: "2.0.0",
      source: "file" as const,
      signed: false,
      environment: null,
    };
    expect(packageUpdated(facts, { kind: "file" }, 1, "1.0.0").fields).toMatchObject({
      package: "unsigned",
      version: null,
      from_version: null,
      provider_host: "file",
    });
  });

  it("a package's facts come from the store's own record, its environment only when declared", () => {
    expect(
      factsOf({
        name: "p",
        document: { version: "1.0.0", environment: { kind: "uv-python" } },
        installed: true,
        signed: true,
        origin: "file",
      }),
    ).toEqual({
      package: "p",
      version: "1.0.0",
      source: "file",
      signed: true,
      environment: "uv-python",
      nodeTypes: [],
    });
    expect(factsOf({ name: "q", document: null, installed: false, signed: false })).toEqual({
      package: "q",
      version: "unknown",
      source: "shipped",
      signed: true,
      environment: null,
      nodeTypes: [],
    });
    expect(
      factsOf({
        name: "r",
        document: { environment: { kind: "java" } },
        installed: true,
        signed: false,
      }),
    ).toMatchObject({ source: "catalogue", environment: null, signed: false });
    // The type ids its declaration lists: the only node_ids a step of it may name.
    expect(
      factsOf({
        name: "s",
        document: { version: "1.0.0", types: [{ id: "probe" }, { id: 7 }, null] },
        installed: false,
        signed: false,
      }).nodeTypes,
    ).toEqual(["probe"]);
  });
});

describe("a deploy's exact counts", () => {
  it("is one event per flow and one per package, every count exact, never a list", () => {
    const perFlow = Array.from({ length: 150 }, (_, n) => n + 1);
    const perPackage = Array.from({ length: 120 }, (_, n) => ({
      package: `p${String(n)}`,
      nodes: n,
    }));
    const events = flowDeployed(perFlow, perPackage, 3);
    const flows = events.filter((event) => event.name === "flow_deployed");
    const packages = events.filter((event) => event.name === "package_deployed");
    const total = perFlow.reduce((sum, count) => sum + count, 0);
    expect(flows.map((event) => event.fields)).toEqual(
      perFlow.map((nodes) => ({ flows: 150, total_nodes: total, nodes, config_nodes: 3 })),
    );
    expect(packages.map((event) => event.fields)).toEqual(perPackage);
    for (const event of events) {
      expect(Object.values(event.fields).some(Array.isArray), event.name).toBe(false);
    }
    // A deploy of no flows tells nothing.
    expect(flowDeployed([], [])).toEqual([]);
  });

  it("every flow's count reaches the queue exactly, past the redaction's list bound", () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    const perFlow = Array.from({ length: 150 }, (_, n) => n);
    for (const event of flowDeployed(perFlow, [])) {
      pipeline.recordUsage(event.name, event.fields);
    }
    expect(world.queue.reports.map((report) => report.payload["nodes"])).toEqual(perFlow);
  });

  it("counts every node: each flow's, the nodes inside its subflow instances, and config nodes", () => {
    const packageOf = (type: string) =>
      type.startsWith("reload-probekit-") ? "probekit" : undefined;
    const flows = [
      { id: "t1", type: "tab" },
      { id: "t2", type: "tab" },
      { id: "a", type: "reload-probekit-probe", z: "t1", wires: [[]] },
      { id: "b", type: "inject", z: "t1", wires: [["a"]] },
      { id: "c", type: "reload-probekit-probe", z: "t2", wires: [] },
      // A subflow of two nodes, one of them an instance of a subflow of one: 1 + 2 + 1 each.
      { id: "s1", type: "subflow" },
      { id: "s1a", type: "function", z: "s1", wires: [[]] },
      { id: "s1b", type: "subflow:s2", z: "s1", wires: [[]] },
      { id: "s2", type: "subflow" },
      { id: "s2a", type: "reload-probekit-probe", z: "s2", wires: [[]] },
      { id: "i1", type: "subflow:s1", z: "t2", wires: [[]] },
      { id: "i2", type: "subflow:s1", z: "t2", wires: [[]] },
      // A subflow that holds itself is counted once, never forever.
      { id: "loop", type: "subflow" },
      { id: "loopi", type: "subflow:loop", z: "loop", wires: [[]] },
      { id: "i3", type: "subflow:loop", z: "t1", wires: [[]] },
      // Config nodes: global, and scoped to a flow; a group is neither.
      { id: "cfg", type: "some-config" },
      { id: "cfg2", type: "mqtt-broker", z: "t1" },
      { id: "g", type: "group", z: "t1" },
      { id: "untyped", z: "t1" },
      "not a node",
    ];
    expect(deployCounts(flows, packageOf)).toEqual({
      kind: "deployed",
      nodesPerFlow: [2 + 2, 1 + 4 + 4],
      perPackage: [
        { package: "probekit", nodes: 2 + 2 },
        { package: CORE_NODES, nodes: 2 + 1 + 6 },
      ],
      configNodes: 2,
    });
    expect(deployCounts([], packageOf)).toEqual({
      kind: "deployed",
      nodesPerFlow: [],
      perPackage: [],
      configNodes: 0,
    });
  });
});

describe("the providers a listing sees", () => {
  const reads = (overrides: Partial<CatalogueReads> = {}): CatalogueReads => ({
    catalogue: () =>
      Promise.resolve({ name: "official", url: "u", verified: true, fetchedAt: 0, entries: [] }),
    catalogueKey: "RWofficial",
    sources: () => [
      { name: "mine", url: "https://mine.example/c.json", publicKey: null, autoUpdate: null },
    ],
    registered: () => Promise.reject(new Error("down")),
    http: { get: () => Promise.reject(new Error("no")) },
    saveDownload: () => "",
    catalogueUrl: "https://catalogue.example/index.json",
    ...overrides,
  });

  it("tells the official one and every registered source, and nothing when the settings cannot be read", async () => {
    const seen: unknown[] = [];
    const catalogues = new PackageCatalogues(reads({ providers: (list) => seen.push(list) }));
    await catalogues.listings(new Set());
    expect(seen).toEqual([
      [
        {
          name: "official",
          url: "https://catalogue.example/index.json",
          official: true,
          publicKey: "RWofficial",
          offered: 0,
        },
        {
          name: "mine",
          url: "https://mine.example/c.json",
          official: false,
          publicKey: null,
          offered: 0,
        },
      ],
    ]);
    const unreadable = new PackageCatalogues(
      reads({
        providers: (list) => seen.push(list),
        sources: () => {
          throw new Error("settings are not JSON");
        },
      }),
    );
    await unreadable.listings(new Set());
    expect(seen).toHaveLength(1);
    const none = new PackageCatalogues(
      reads({ catalogueUrl: "", providers: (list) => seen.push(list) }),
    );
    await none.listings(new Set());
    expect(seen.at(-1)).toEqual([expect.objectContaining({ name: "mine" })]);
  });

  it("knows each catalogue's address, and where an installed package came from", () => {
    const catalogues = new PackageCatalogues(reads());
    expect(catalogues.urlOf("official")).toBe("https://catalogue.example/index.json");
    expect(catalogues.urlOf("mine")).toBe("https://mine.example/c.json");
    expect(catalogues.urlOf("gone")).toBeNull();
    expect(new PackageCatalogues(reads({ catalogueUrl: "" })).urlOf("official")).toBeNull();
    const broken = new PackageCatalogues(
      reads({
        sources: () => {
          throw new Error("unreadable");
        },
      }),
    );
    expect(broken.urlOf("mine")).toBeNull();
    expect(catalogues.installOrigin({ kind: "file", path: "/Users/x/p.tgz" })).toEqual({
      kind: "file",
    });
    expect(catalogues.installOrigin({ kind: "catalogue", source: "mine", id: "p" })).toEqual({
      kind: "catalogue",
      url: "https://mine.example/c.json",
      official: false,
    });
    expect(catalogues.installOrigin({ kind: "catalogue", source: "official", id: "p" })).toEqual({
      kind: "catalogue",
      url: "https://catalogue.example/index.json",
      official: true,
    });
    expect(catalogues.installOrigin(undefined)).toEqual({
      kind: "catalogue",
      url: null,
      official: false,
    });
  });
});

describe("the vouched fields", () => {
  it("keep their text past the key-name rule, still redacted, and only as text", () => {
    const redact = (text: string) => text.replaceAll("fake-secret-123456", REDACTED);
    const payload = {
      file: "src/node.py",
      environment: "uv-python",
      provider_host: "fake-secret-123456.example",
      file_path: "src/other.py",
    };
    expect(redactPayload(payload, redact, [], VOUCHED_FIELDS)).toEqual({
      file: "src/node.py",
      environment: "uv-python",
      provider_host: `${REDACTED}.example`,
      file_path: REDACTED,
    });
    expect(
      redactPayload({ file: { nested: "x" }, environment: null }, redact, [], VOUCHED_FIELDS),
    ).toEqual({
      file: REDACTED,
      environment: null,
    });
    expect(redactPayload({ file: "src/node.py" }, redact)).toEqual({ file: REDACTED });
  });
});

describe("Umami's batch request and the pipeline's batches", () => {
  const usage = (n: number): QueuedReport => ({
    sequence: n,
    kind: "usage",
    payload: { event: "package_used", n },
  });
  const crash: QueuedReport = { sequence: 99, kind: "error", payload: { report_id: "r", at: "t" } };

  it("sends one event to /api/send and up to 50 to /api/batch, each named as its signal", () => {
    expect(outgoingFor([usage(1)], ENDPOINTS, "1.0.0").url).toBe("https://umami.test/api/send");
    const batch = outgoingFor([usage(1), usage(2)], ENDPOINTS, "1.0.0");
    expect(batch.url).toBe("https://umami.test/api/batch");
    expect(
      (JSON.parse(batch.body) as { payload: { name: string; data: { n: number } } }[]).map(
        (event) => [event.payload.name, event.payload.data.n],
      ),
    ).toEqual([
      ["package_used", 1],
      ["package_used", 2],
    ]);
    const unnamed = { sequence: 3, kind: "usage" as const, payload: {} };
    expect(JSON.parse(outgoingFor(unnamed, ENDPOINTS, "1").body)).toMatchObject({
      payload: { name: "usage" },
    });
  });

  it("refuses an empty request, more than 50, a crash report with company, and a mixed batch", () => {
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, n) => usage(n));
    expect(() => outgoingFor([], ENDPOINTS, "1")).toThrow("1 to 50 reports");
    expect(() => outgoingFor(many, ENDPOINTS, "1")).toThrow("1 to 50 reports");
    expect(() => outgoingFor([crash, crash], ENDPOINTS, "1")).toThrow("sent alone");
    expect(() => outgoingFor([usage(1), crash], ENDPOINTS, "1")).toThrow("usage events only");
  });

  it("drains 120 events in three requests, and a crash report between them on its own", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    for (let n = 0; n < 60; n += 1) {
      pipeline.recordUsage("package_used", { n });
    }
    pipeline.recordCrash({ crashed: "runtime" });
    for (let n = 60; n < 120; n += 1) {
      pipeline.recordUsage("package_used", { n });
    }
    expect(await pipeline.flush()).toEqual({ sent: 121, retryInMs: null });
    expect(world.poster.sent.map((request) => request.url)).toEqual([
      "https://umami.test/api/batch",
      "https://umami.test/api/batch",
      "https://glitchtip.test/api/42/envelope/",
      "https://umami.test/api/batch",
      "https://umami.test/api/batch",
    ]);
    expect(world.queue.reports).toEqual([]);
  });

  it("a batch that fails keeps every one of its events for the retry", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    world.poster.answer = () => ({ ok: false, detail: "503" });
    pipeline.recordUsage("app_start", {});
    pipeline.recordUsage("setup_step", {});
    expect((await pipeline.flush()).sent).toBe(0);
    expect(world.queue.reports).toHaveLength(2);
    await settle();
  });

  it("every report is stamped with the rules; one under other rules is dropped, and each field is held to its rule again at send", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordUsage("package_used", { package: "probekit", version: "1.0.0" });
    expect(world.queue.reports[0]?.payload["rules"]).toBe(RULES_VERSION);
    // A report queued by an older build (no stamp, or another), and one changed on disk.
    world.queue.enqueue("usage", { event: "app_start", startup_ms: 1 });
    world.queue.enqueue("usage", { event: "app_start", rules: RULES_VERSION - 1 });
    world.queue.enqueue("usage", {
      event: "package_error",
      rules: RULES_VERSION,
      machine_id: world.queue.reports[0]?.payload["machine_id"] ?? null,
      report_id: "f".repeat(32),
      error_type: "sk_live_abc123",
      version: "1.0.0-Ab3d.Ef6h.Ij9k",
      client: "bob hunter2",
      error_code: 4111111111111111,
      note: "free text nobody asked for",
      list: ["a"],
      ok: true,
      line: 3,
    });
    expect(await pipeline.flush()).toEqual({ sent: 2, retryInMs: null });
    expect(world.queue.reports).toEqual([]);
    const sent = JSON.parse(world.poster.sent[0]?.body ?? "[]") as {
      payload: { data: Record<string, unknown> };
    }[];
    expect(sent).toHaveLength(2);
    const data = sent[1]?.payload.data ?? {};
    expect(data).toMatchObject({
      error_type: WITHHELD,
      version: WITHHELD,
      // No package the store vouches for: no file of it, so no line either.
      line: WITHHELD,
      ok: true,
    });
    // Keys that are not package_error's own never leave, whatever they hold.
    for (const key of ["client", "error_code", "note", "list"]) {
      expect(Object.keys(data)).not.toContain(key);
    }
    expect(world.logger.lines.join("\n")).toContain("made under other rules is dropped unsent");
  });

  it("a name that is not a signal is never queued", () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    expect(pipeline.recordUsage("usage" as never, {})).toBeNull();
    expect(world.queue.reports).toEqual([]);
    expect(world.logger.lines.join("\n")).toContain("names no known signal");
  });
});

describe("the launch marker and the telemetry memory on disk", () => {
  let scratch = "";
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps the marker until cleared, and the memory as written, readable by this user only", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-marks-"));
    const marks = new FsTelemetryMarks(scratch, new RecordingLogger());
    expect(marks.readRunning()).toBeNull();
    expect(marks.readMemory()).toBeNull();
    marks.writeRunning("0.5.0");
    expect(new FsTelemetryMarks(scratch, new RecordingLogger()).readRunning()).toBe("0.5.0");
    const state = path.join(scratch, "telemetry-state");
    expect(fs.statSync(path.join(state, "telemetry-running")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
    marks.clearRunning();
    marks.clearRunning();
    expect(marks.readRunning()).toBeNull();
    const memory = {
      reached: ["launched"],
      told: ["launched"],
      providers: { official: { host: "c.example", official: true } },
    };
    marks.writeMemory(memory);
    expect(marks.readMemory()).toEqual(memory);
  });

  it("tightens a file and a folder that already existed wider to 0600 and 0700", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-marks-"));
    const state = path.join(scratch, "telemetry-state");
    fs.mkdirSync(state, { mode: 0o755 });
    fs.chmodSync(state, 0o755);
    const file = path.join(state, "telemetry-memory.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    new FsTelemetryMarks(scratch, new RecordingLogger()).writeMemory({
      reached: [],
      told: [],
      providers: {},
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
  });

  it("reads a damaged memory as what it can trust, and logs a write it could not make", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-marks-"));
    fs.mkdirSync(path.join(scratch, "telemetry-state"));
    const file = path.join(scratch, "telemetry-state", "telemetry-memory.json");
    fs.writeFileSync(file, "{broken");
    const logger = new RecordingLogger();
    const marks = new FsTelemetryMarks(scratch, logger);
    expect(marks.readMemory()).toBeNull();
    fs.writeFileSync(
      file,
      JSON.stringify({
        reached: "x",
        told: [1],
        providers: {
          a: { host: 1 },
          b: null,
          c: { host: "c.example", official: false },
          d: { host: null, official: true },
          e: { url: "https://u:p@e.example", official: false },
        },
      }),
    );
    expect(marks.readMemory()).toEqual({
      reached: [],
      told: [],
      providers: { c: { host: "c.example", official: false }, d: { host: null, official: true } },
    });
    fs.writeFileSync(file, JSON.stringify({ providers: [] }));
    expect(marks.readMemory()).toEqual({ reached: [], told: [], providers: {} });
    fs.writeFileSync(file, "null");
    expect(marks.readMemory()).toEqual({ reached: [], told: [], providers: {} });
    const blocked = path.join(scratch, "a-file");
    fs.writeFileSync(blocked, "");
    new FsTelemetryMarks(path.join(blocked, "inside"), logger).writeRunning("1.0.0");
    expect(logger.lines.join("\n")).toContain("telemetry-running could not be written");
  });
});
