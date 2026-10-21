// The credential gate (plan 0029, "No credentials, ever"): rule 2, a field named like a
// credential refuses the report; rule 3, a URL is reduced to its host; rule 4, free text is
// scrubbed, then withheld if in doubt; rule 5, the proof: fake credentials, some registered with
// the redactor and some nobody knew, are planted in every string every builder takes, and no
// queued or sent byte may contain any of them or any credential shape.
//
// BUILDERS is the table every later signal joins: one row per builder in reports.ts, building its
// report with the planted text in every string input and recording it through the pipeline.
//
// Every fake value says "fake" (or is too short to be read as a key), so the repository's own
// secret scans (no-secrets.test.ts, test_no_secrets.py) excuse them by construction.
import { describe, expect, it } from "vitest";
import { TelemetryPipeline } from "../../src/application/telemetry";
import {
  CREDENTIAL_NAME_FRAGMENTS,
  hostOnly,
  scrubFreeText,
  WITHHELD,
  type Json,
} from "../../src/domain/telemetry/redact";
import {
  crashPayload,
  usagePayload,
  type QueuedReport,
  type Versions,
} from "../../src/domain/telemetry/reports";
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

/** Every builder in reports.ts. A new signal adds its row here. */
const BUILDERS: readonly BuilderFixture[] = [
  {
    name: "usagePayload",
    record: (pipeline, planted) =>
      pipeline.recordUsage(usagePayload(versionsOf(planted), [{ id: planted, version: planted }])),
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
        expect(pipeline.recordUsage(payload)).toBeNull();
        expect(world.queue.reports).toEqual([]);
        expect(world.logger.lines.join("\n")).toContain(
          `a usage report could not be queued: a field's name contains "${fragment}"`,
        );
      }
    },
  );

  it("the existing reports' field names pass", () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    const versions = { appVersion: "0.4.0", os: "darwin", osVersion: "25.3.0", arch: "arm64" };
    expect(
      pipeline.recordUsage({
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
