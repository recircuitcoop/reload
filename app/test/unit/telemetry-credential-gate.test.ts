// The credential gate (plan 0029, "No credentials, ever"): rule 2, a field named like a
// credential refuses the report; rule 3, a URL is reduced to its host; rule 4, free text is
// scrubbed, then withheld if in doubt; rule 5, the proof: fake credentials, some registered with
// the redactor and some nobody knew, are planted in every string every builder takes, and no
// queued or sent byte may contain any of them or any credential shape.
//
// BUILDERS is the table every signal joins: one row per builder in reports.ts (test/fakes/
// signals.ts builds each with the planted text in every string input), recorded through the
// pipeline. HOOKS drives the code that hears each signal, from the hostile inputs it can see
// (an error frame, a stack, an MCP tool's arguments, a provider's URL, a file path) to the queue.
// Rule 6: a package chooses no field, whatever its frame carries.
//
// Every fake value says "fake" (or is too short to be read as a key), so the repository's own
// secret scans (no-secrets.test.ts, test_no_secrets.py) excuse them by construction.
import fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TelemetryPipeline } from "../../src/application/telemetry";
import {
  credentialFieldName,
  CREDENTIAL_NAME_FRAGMENTS,
  hostOnly,
  scrubFreeText,
  WITHHELD,
  type Json,
} from "../../src/domain/telemetry/redact";
import { failureOf, stepSignal } from "../../src/adapters/process/codec";
import { mcpDispatch } from "../../src/application/mcp-dispatch";
import { UsageSignals } from "../../src/application/usage-signals";
import { parseChildSignal } from "../../src/domain/channel/messages";
import {
  crashPayload,
  SIGNALS,
  usagePayload,
  type ChildSignal,
  type QueuedReport,
  type Versions,
} from "../../src/domain/telemetry/reports";
import { fingerprintOf } from "../../src/shell/telemetry";
import { unpairedFiles } from "../fakes/anytype";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { everySignal } from "../fakes/signals";
import { telemetryWorld } from "../fakes/telemetry";

// ── the fakes ────────────────────────────────────────────────────────────────────────────

/** Registered with the redactor, as the services process and the runtime register theirs. */
const REGISTERED = [
  "fake-anytype-key-Q7w9Z2x4mK",
  "fake-proxy-token-R5t6Y7u8iO",
  "fake-nodered-secret-P0o9I8u7",
  "fake-package-secret-L1k2J3h4",
];
const [ANYTYPE_KEY = "", PROXY_TOKEN = "", NODE_RED_SECRET = "", PACKAGE_SECRET = ""] = REGISTERED;

/** Nobody registered these: only their shape can catch them. */
const URL_USER = "fakeuser";
const URL_PASSWORD = "fakepass-W3e4R5";
const QUERY_TOKEN = "fakeQueryTok9Z8Y7X6W5V4U3T2S";
const BARE_TOKEN = "fakeBearer1A2B3C4D5E6F7G8H";
const PAIR_PASSWORD = "fakePw-77Hh";
// A JWT whose parts decode to {"fake":1}, {"fake":2} and "fake-signature".
const JWT = "eyJmYWtlIjoxfQ.eyJmYWtlIjoyfQ.ZmFrZS1zaWduYXR1cmU";
const HEX_RUN = "0123456789abcdef0123456789abcdef";

const UNREGISTERED = [URL_USER, URL_PASSWORD, QUERY_TOKEN, BARE_TOKEN, PAIR_PASSWORD, JWT, HEX_RUN];
const EVERY_FAKE = [...REGISTERED, ...UNREGISTERED];

/** Every way a credential reaches a string a signal's hook can see. */
const HOSTILE: readonly string[] = [
  ...REGISTERED,
  `failed with ${ANYTYPE_KEY} at /Users/fake-person/notes.md`,
  `Authorization: Bearer ${BARE_TOKEN}`,
  `Bearer ${BARE_TOKEN}`,
  `https://${URL_USER}:${URL_PASSWORD}@provider.example/catalogue?token=${QUERY_TOKEN}#${PROXY_TOKEN}`,
  `error: token=${QUERY_TOKEN} password=${PAIR_PASSWORD} secret=${PACKAGE_SECRET} key=${NODE_RED_SECRET}`,
  `{"api_key": "${QUERY_TOKEN}"}`,
  `upstream said ${JWT}`,
  `digest ${HEX_RUN}`,
  new Error(`node threw while holding ${NODE_RED_SECRET} and ${BARE_TOKEN}`).message,
];

/**
 * The shapes rule 4 names, written here independently of the scrub so the gate does not grade
 * itself: none may match a queued string.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /bearer\s+\S/i,
  /authorization\s*:/i,
  /\b(?:key|token|password|secret)\s*=/i,
  /eyJ[\w-]+\.[\w-]+\./,
  /:\/\/[^\s/]*@/,
  /[A-Fa-f0-9]{24,}/,
  /(?=[\w-]*\d)[\w-]{24,}/,
];

/** The pipeline's own identifiers: stamped by it, hex by construction, never anybody's input. */
const OWN_IDENTIFIERS = ["machine_id", "report_id"];

// ── the builders ─────────────────────────────────────────────────────────────────────────

interface BuilderFixture {
  readonly name: string;
  /** Build the report with `planted` in every string the builder takes, and record it. */
  readonly record: (pipeline: TelemetryPipeline, planted: string) => QueuedReport | null;
}

const versionsOf = (planted: string): Versions => ({
  appVersion: planted,
  os: planted,
  osVersion: planted,
  arch: planted,
});

const COUNTS = { runtime: 1, services: 2, node: 3, nodeStopped: 1 };

/** Every builder in reports.ts, through the shell's UsageSignals (the version fields join them). */
const SIGNAL_ROWS: readonly BuilderFixture[] = SIGNALS.flatMap((name) =>
  [true, false].map((signed) => ({
    name: `${name}${signed ? "" : " (unsigned)"}`,
    record: (pipeline: TelemetryPipeline, planted: string) => {
      const signal = everySignal(planted, signed).find((built) => built.name === name);
      if (signal === undefined) {
        throw new Error(`no builder makes ${name}`);
      }
      const recorded = usage(pipeline, planted).record(signal);
      return recorded ? (pipeline.pending().at(-1) ?? null) : null;
    },
  })),
);

/** The shell's mapper over `pipeline`, its version fields planted too, its store knowing one package. */
const usage = (pipeline: TelemetryPipeline, planted: string): UsageSignals =>
  new UsageSignals({
    record: (event, payload) => pipeline.recordUsage(event, payload),
    versions: versionsOf(planted),
    packages: () => [
      { name: planted, document: { version: planted }, installed: true, signed: true },
    ],
  });

/** Every builder in reports.ts. A new signal adds its row in test/fakes/signals.ts. */
const BUILDERS: readonly BuilderFixture[] = [
  ...SIGNAL_ROWS,
  {
    name: "usagePayload",
    record: (pipeline, planted) =>
      pipeline.recordUsage(
        "app_start",
        usagePayload(versionsOf(planted), [{ id: planted, version: planted }]),
      ),
  },
  {
    name: "crashPayload",
    record: (pipeline, planted) =>
      pipeline.recordCrash(crashPayload("node", true, COUNTS, versionsOf(planted))),
  },
  {
    // No builder: what a careless caller might hand the pipeline, nested, in an error message
    // and in a URL. The gate is the pipeline's, so it holds here too.
    name: "a hand-made payload",
    record: (pipeline, planted) =>
      pipeline.recordCrash({
        error: new Error(planted).message,
        provider: planted,
        detail: [planted, { deeper: [planted, { deepest: planted }] }],
      }),
  },
];

/** Every string value in a queued payload, at any depth, but the pipeline's own identifiers. */
function stringsIn(value: Json, top = true): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsIn(item, false));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !(top && OWN_IDENTIFIERS.includes(key)))
      .flatMap(([, item]) => stringsIn(item, false));
  }
  return [];
}

/** What a leak check finds in `text`: each fake it contains and each shape it matches. */
function leaksIn(text: string): string[] {
  return [
    ...EVERY_FAKE.filter((fake) => text.includes(fake)),
    ...CREDENTIAL_SHAPES.filter((shape) => shape.test(text)).map(String),
  ];
}

// ── rule 5: the proof ────────────────────────────────────────────────────────────────────

describe.each(BUILDERS)("the credential gate: $name", ({ record }) => {
  it.each(HOSTILE)("no fake credential or credential shape leaves with %s", async (planted) => {
    const world = telemetryWorld("on");
    for (const secret of REGISTERED) {
      world.registry.protect(secret);
    }
    const pipeline = new TelemetryPipeline(world.deps);
    const report = record(pipeline, planted);
    // Queued, not dropped: a gate that passes by sending nothing proves nothing.
    expect(report).not.toBeNull();
    const queuedBytes = JSON.stringify(world.queue.reports);
    expect(EVERY_FAKE.filter((fake) => queuedBytes.includes(fake))).toEqual([]);
    for (const queued of world.queue.reports) {
      expect(stringsIn(queued.payload).flatMap(leaksIn)).toEqual([]);
    }
    await pipeline.flush();
    const sentBytes = JSON.stringify(world.poster.sent);
    expect(world.poster.sent).toHaveLength(1);
    expect(EVERY_FAKE.filter((fake) => sentBytes.includes(fake))).toEqual([]);
  });
});

describe("the credential gate: its own check can fail", () => {
  it("every planted string is seen by the leak check before the gate", () => {
    for (const planted of HOSTILE) {
      expect(leaksIn(planted)).not.toEqual([]);
    }
  });
});

// ── rule 5, through the hooks: from what each hook can see to the queue ───────────────────

const IDENTITY = {
  id: "n1",
  flowId: "f1",
  package: "probekit",
  typeId: "probe",
  type: "reload-probekit-probe",
  name: "",
  kind: "node" as const,
};

/** The hooks, each handed `planted` wherever its input can carry one, giving the child's facts. */
const HOOKS: readonly {
  readonly name: string;
  readonly facts: (planted: string) => Promise<ChildSignal[]>;
}[] = [
  {
    name: "a failed step's error frame: its message, its type, its file, a stack, extra fields",
    facts: (planted) =>
      Promise.resolve([
        stepSignal(
          IDENTITY,
          12,
          false,
          failureOf({
            t: "error",
            in: "i1",
            message: `${planted}\n    at run (/Users/fake-person/${planted}/node.js:3:1)`,
            error_type: planted,
            file: `src/${planted}.py`,
            line: 3,
          }),
        ),
      ]),
  },
  {
    name: "a step whose facts crossed the channel with extra fields a package added",
    facts: (planted) =>
      Promise.resolve(
        [
          parseChildSignal({
            kind: "step",
            package: "probekit",
            step: { nodeKind: "node", nodeId: "probe", durationMs: 1, ok: false, token: planted },
            failure: { errorType: null, message: null, file: planted, line: 1, config: planted },
            payload: planted,
          }),
        ].filter((signal): signal is ChildSignal => signal !== null),
      ),
  },
  {
    name: "an MCP tools/call: its arguments, its result, its client's name",
    facts: async (planted) => {
      const told: ChildSignal[] = [];
      const session = {
        closed: false,
        initialize: () => Promise.resolve([]),
        ping: () => Promise.resolve(),
        request: () => Promise.resolve({ content: [{ type: "text", text: planted }] }),
        close: () => undefined,
        onBroken: () => undefined,
      };
      const handle = mcpDispatch({
        served: () => ({ session, tools: [{ name: "API-get-object", inputSchema: {} }] }),
        redact: (text) => text,
        clock: new FakeClock(),
        logger: new RecordingLogger(),
        files: unpairedFiles(new RecordingLogger()),
        observe: (call) => told.push({ kind: "mcp-call", call }),
      });
      const send = (body: unknown) => handle(new TextEncoder().encode(JSON.stringify(body)));
      await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: planted } },
      });
      await send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "API-get-object", arguments: { key: planted, query: planted } },
      });
      await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: planted } });
      return told;
    },
  },
];

describe.each(HOOKS)("the credential gate, through the hook: $name", ({ facts }) => {
  it.each(HOSTILE)("no fake credential or credential shape leaves with %s", async (planted) => {
    const world = telemetryWorld("on");
    for (const secret of REGISTERED) {
      world.registry.protect(secret);
    }
    const pipeline = new TelemetryPipeline(world.deps);
    const signals = new UsageSignals({
      record: (event, payload) => pipeline.recordUsage(event, payload),
      versions: { appVersion: "1.0.0", os: "darwin", osVersion: "25.3.0", arch: "arm64" },
      packages: () => [
        { name: "probekit", document: { version: "0.3.0" }, installed: true, signed: true },
      ],
    });
    const told = await facts(planted);
    expect(told.length).toBeGreaterThan(0);
    for (const signal of told) {
      signals.child(signal);
    }
    expect(world.queue.reports.length).toBeGreaterThan(0);
    const queuedBytes = JSON.stringify(world.queue.reports);
    expect(EVERY_FAKE.filter((fake) => queuedBytes.includes(fake))).toEqual([]);
    expect(queuedBytes).not.toContain("fake-person");
    for (const queued of world.queue.reports) {
      expect(stringsIn(queued.payload).flatMap(leaksIn)).toEqual([]);
    }
  });
});

describe("the credential gate: a provider's URL and an install's file (rules 3 and 5)", () => {
  it("a provider URL with user:pass@ and ?token= sends only the host; a file sends no path", () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    const signals = usage(pipeline, "0.4.0");
    const url = `https://${URL_USER}:${URL_PASSWORD}@provider.example:8443/c/index.json?token=${QUERY_TOKEN}#${PROXY_TOKEN}`;
    const registered = only(
      everySignal(url).filter((signal) => signal.name === "provider_registered"),
    );
    signals.record({
      ...registered,
      fields: { ...registered.fields, signer_fingerprint: fingerprintOf("RWfakeKey") },
    });
    for (const signal of everySignal(url)) {
      if (signal.name.startsWith("package_install") || signal.name === "provider_removed") {
        signals.record(signal);
      }
    }
    const fileInstall = everySignal("/Users/fake-person/Downloads/my-package.tgz").find(
      (signal) => signal.name === "package_updated",
    );
    signals.record(only(fileInstall === undefined ? [] : [fileInstall]));
    const hosts = world.queue.reports.map((report) => report.payload["provider_host"]);
    expect(hosts).toEqual([
      "provider.example",
      "provider.example",
      "provider.example",
      "provider.example",
      "file",
    ]);
    const bytes = JSON.stringify(world.queue.reports);
    for (const leak of [
      URL_USER,
      URL_PASSWORD,
      QUERY_TOKEN,
      PROXY_TOKEN,
      "8443",
      "index.json",
      "fake-person",
      "Downloads",
      "my-package.tgz",
    ]) {
      expect(bytes).not.toContain(leak);
    }
  });
});

/** The one item of `items`; a test of a builder that makes none fails here. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined || items.length !== 1) {
    throw new Error(`expected exactly one, got ${String(items.length)}`);
  }
  return item;
}

// ── rule 6: nothing is sent by a package ──────────────────────────────────────────────────

describe("the credential gate: a package chooses no field (rule 6)", () => {
  it("an error frame's facts are the four named ones, whatever else the frame carries", () => {
    const failure = failureOf({
      t: "error",
      message: "m",
      error_type: "E",
      file: "f.py",
      line: 2,
      ...({ api_key: "x", event: "app_start", machine_id: "x" } as object),
    });
    expect(Object.keys(failure).sort()).toEqual(["errorType", "file", "line", "message"]);
  });

  it("no package or SDK file names the telemetry endpoints or posts an event itself", () => {
    const repo = path.resolve(import.meta.dirname, "..", "..", "..");
    const sources = [
      "sdk/ts/src/node.ts",
      "sdk/python/src/reload_node/__init__.py",
      ...fs
        .readdirSync(path.join(repo, "packages"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(ts|py)$/.test(entry.name))
        .filter((entry) => !entry.parentPath.includes("node_modules"))
        .map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name))),
    ];
    for (const file of sources) {
      const text = fs.readFileSync(path.join(repo, file), "utf8");
      expect(text, file).not.toMatch(/umami|glitchtip|api\/send|api\/batch|telemetry/i);
    }
  });
});

// ── rule 2: no field is named like a credential ──────────────────────────────────────────

describe("the credential gate: field names (rule 2)", () => {
  it.each(CREDENTIAL_NAME_FRAGMENTS)(
    "a field whose name contains %s refuses the report, at any depth",
    (fragment) => {
      for (const payload of [
        { [`my_${fragment}`]: 1 },
        { outer: { [fragment.toUpperCase()]: "x" } },
        { list: [{ ok: 1 }, { [`${fragment}_id`]: 2 }] },
      ]) {
        const world = telemetryWorld("on");
        const pipeline = new TelemetryPipeline(world.deps);
        expect(pipeline.recordUsage("app_start", payload)).toBeNull();
        expect(world.queue.reports).toEqual([]);
        expect(world.logger.lines.join("\n")).toContain(
          `a usage report could not be queued: a field's name contains "${fragment}"`,
        );
      }
    },
  );

  it("every builder's every field name passes, at any depth, signed or not", () => {
    for (const signal of [...everySignal("x"), ...everySignal("x", false)]) {
      expect(credentialFieldName(signal.fields), signal.name).toBeNull();
    }
  });

  it("the existing reports' field names pass", () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    const versions = { appVersion: "0.4.0", os: "darwin", osVersion: "25.3.0", arch: "arm64" };
    expect(
      pipeline.recordUsage("app_start", {
        ...usagePayload(versions, [{ id: "reload_anytype", version: "1.0.0" }]),
        unsigned_packages: 0,
      }),
    ).not.toBeNull();
    expect(pipeline.recordCrash(crashPayload("runtime", false, COUNTS, versions))).not.toBeNull();
    expect(world.queue.reports).toHaveLength(2);
  });
});

// ── rule 3: a URL is reduced to its host ─────────────────────────────────────────────────

describe("the credential gate: hostOnly (rule 3)", () => {
  it("keeps only the hostname", () => {
    expect(
      hostOnly(
        `https://${URL_USER}:${URL_PASSWORD}@Provider.Example:8443/a/b?token=${QUERY_TOKEN}#frag`,
      ),
    ).toBe("provider.example");
    expect(hostOnly("https://catalogue.recircu.it")).toBe("catalogue.recircu.it");
  });

  it("is null for what is not a URL, or has no host", () => {
    expect(hostOnly("not a url")).toBeNull();
    expect(hostOnly("catalogue.example/path")).toBeNull();
    expect(hostOnly("")).toBeNull();
    expect(hostOnly("file:///Users/fake-person/package.zip")).toBeNull();
  });
});

// ── rule 4: free text is scrubbed, then withheld if in doubt ─────────────────────────────

describe("the credential gate: scrubFreeText (rule 4)", () => {
  it("leaves ordinary text alone", () => {
    for (const text of [
      "ZeroDivisionError: division by zero",
      "cannot read properties of undefined (reading 'length')",
      "node-red-contrib-something-quite-long failed",
    ]) {
      expect(scrubFreeText(text)).toBe(text);
    }
    // A name ending in "key" followed by a value reads as a pair: the value goes, the text stays.
    expect(scrubFreeText("KeyError: 'title'")).toBe("KeyError: [redacted]");
  });

  it("scrubs a long hash, a JWT and a URL's userinfo in place", () => {
    expect(scrubFreeText(`digest ${HEX_RUN} mismatch`)).toBe("digest [redacted] mismatch");
    expect(scrubFreeText(`got ${JWT} back`)).toBe("got [redacted] back");
    expect(scrubFreeText(`fetch https://${URL_USER}:${URL_PASSWORD}@host.example/x failed`)).toBe(
      "fetch https://host.example/x failed",
    );
  });

  it("withholds the text when anything credential-like remains", () => {
    for (const text of [
      `Bearer ${BARE_TOKEN}`,
      `Authorization: Basic ${PAIR_PASSWORD}`,
      `token=${QUERY_TOKEN}`,
      `"password": "${PAIR_PASSWORD}"`,
      "the api_key was refused",
      // A 16-character key: shorter than the scrub's runs, still a key.
      "rejected a1B2c3D4e5F6g7H8",
    ]) {
      expect(scrubFreeText(text)).toBe(WITHHELD);
    }
  });
});
