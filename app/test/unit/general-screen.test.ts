// ui/general.ts (plan 0022 §M, ux-writing "Configuration › General"): each section's one-line
// state, the address AI apps are told, the setup a client is given, a refused move in words, and
// retention's five choices (D8). No DOM: the screen only draws these.
import fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnytypeStatus, FlowSummary, McpEndpointStatus } from "../../src/ui/contract";
import {
  aiAppsLine,
  anytypeLine,
  CHATGPT_STEPS,
  clientSetup,
  codeParts,
  FOLDER_SOURCE_TYPE,
  folderName,
  LIMIT_FIELDS,
  limitErrors,
  limitsToSave,
  limitsTyped,
  folderSteps,
  recorderLine,
  moveRefusal,
  nameParts,
  PACKAGE_ACTIONS,
  packagesLine,
  PRIVACY_NOTICE,
  PRIVACY_NOTICE_OPENING,
  readEndpoint,
  readSpaces,
  reportsLine,
  RETENTION_OPTIONS,
  retentionDays,
  retentionLine,
  retentionValue,
  servedAddress,
  servedHost,
  servedPort,
  showsPrivacyNotice,
  withoutMarks,
} from "../../src/ui/general";
import type { Answer, RefusalReason } from "../../src/ui/answer";
import type { NodeOptions } from "../../src/ui/flow-contract";
import type { PackagesView } from "../../src/ui/general-contract";
import { wordChecked } from "../../src/ui/words";
import { checkedAddress } from "../../src/domain/endpoint/address";
import {
  INSTALLATION_STATES,
  PACKAGE_UPDATE_STATES,
  rowActions,
  type Installation,
  type Package,
  type PackageUpdate,
} from "../../src/domain/packages/states";
import type { AppApiV2 } from "../../src/ui/app-api-v2";
import { STRINGS, type PlainKey } from "../../src/ui/strings";
import packageJson from "../../package.json";
import {
  appStart,
  NOTICE_VERSION,
  SIGNALS,
  USAGE_RETENTION_MONTHS,
  versionFields,
  type SignalName,
} from "../../src/domain/telemetry/reports";
import type { Json } from "../../src/domain/telemetry/redact";
import { everySignal } from "../fakes/signals";
import {
  flatten,
  outgoingFor,
  UMAMI_HOSTNAME,
  UMAMI_URL_PATH,
} from "../../src/domain/telemetry/transports";
import { reportedPackages, telemetryEndpoints } from "../../src/shell/telemetry";
import { TelemetryPipeline } from "../../src/application/telemetry";
import { telemetryWorld } from "../fakes/telemetry";

const anytype = (state: AnytypeStatus["state"]): AnytypeStatus => ({
  state,
  detail: "added=[API-x] differ from the committed surface",
  childPid: 4242,
  beats: 3,
  pairing: false,
});

const spaces = (n: number) => ({
  ok: true as const,
  value: { options: Array.from({ length: n }, (_, i) => ({ value: `s${String(i)}`, label: "S" })) },
});

const endpoint = (served: string | null): McpEndpointStatus => ({
  served,
  saved: served,
  stored: false,
  ignoredVariables: [],
  problem: null,
  warning: "clients must be updated",
});

describe("the Anytype section's state line", () => {
  it("says Connected · n spaces once paired and Not paired yet. before, with Pair or Pair again", () => {
    expect(anytypeLine(anytype("ready"), spaces(8))).toEqual({
      line: "Connected · 8 spaces",
      paired: true,
    });
    expect(anytypeLine(anytype("ready"), spaces(1)).line).toBe("Connected · 1 space");
    expect(anytypeLine(anytype("no-key"), null)).toEqual({
      line: STRINGS["general.anytype.notPaired"],
      paired: false,
    });
  });

  it("names an unreachable Anytype, a refused key and a start, never the detail or a path", () => {
    expect(anytypeLine(anytype("unreachable"), null).line).toBe(
      STRINGS["error.anytypeUnreachable"],
    );
    expect(anytypeLine(anytype("starting"), null).line).toBe(STRINGS["general.anytype.starting"]);
    expect(anytypeLine(anytype("ready"), null).line).toBe(STRINGS["general.anytype.starting"]);
    const refused = (reason: "not-paired" | "unreachable" | "failed") => ({
      ok: false as const,
      refused: { reason, sentence: "refused.failed" as const },
    });
    expect(anytypeLine(anytype("ready"), refused("not-paired")).line).toBe(
      STRINGS["error.keyRefused"],
    );
    expect(anytypeLine(anytype("ready"), refused("unreachable")).line).toBe(
      STRINGS["error.anytypeUnreachable"],
    );
    expect(anytypeLine(anytype("ready"), refused("failed")).line).toBe(
      STRINGS["general.anytype.connected"],
    );
    for (const state of ["tool-surface-mismatch", "down", "down-for-good", "stopped"] as const) {
      const line = anytypeLine(anytype(state), null);
      expect(line.line).toBe(STRINGS["general.anytype.unavailable"]);
      expect(line.line).not.toContain("added=");
    }
  });
});

describe("Anytype's spaces, read once Anytype is ready", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const refusal = (reason: RefusalReason): Answer<NodeOptions> => ({
    ok: false,
    refused: { reason, sentence: "refused.failed" },
  });
  const listed: Answer<NodeOptions> = {
    ok: true,
    value: { options: [{ value: "sp-work", label: "Work" }] },
  };
  /** Reads the spaces with `answers` given in turn (the last one repeated); counts the asks. */
  function reading(answers: Answer<NodeOptions>[]) {
    let asks = 0;
    const shown: Answer<NodeOptions>[] = [];
    const stop = readSpaces(
      () => Promise.resolve(answers[Math.min(asks++, answers.length - 1)] as Answer<NodeOptions>),
      (answer) => shown.push(answer),
      2_000,
    );
    return { asks: () => asks, shown, stop };
  }

  it.each(["down", "not-paired", "unreachable", "unavailable", "failed"] as const)(
    "%s is shown once and not asked again",
    async (reason) => {
      vi.useFakeTimers();
      const read = reading([refusal(reason)]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(read.asks()).toBe(1);
      expect(read.shown).toEqual([refusal(reason)]);
      read.stop();
    },
  );

  it("restarting is asked again every 2 s until it is answered, then not again", async () => {
    vi.useFakeTimers();
    const read = reading([refusal("restarting"), refusal("restarting"), listed]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.asks()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read.asks()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read.asks()).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read.asks()).toBe(3);
    expect(read.shown).toEqual([refusal("restarting"), refusal("restarting"), listed]);
    read.stop();
  });

  it("stopped, it asks no more and shows nothing more", async () => {
    vi.useFakeTimers();
    const read = reading([refusal("restarting")]);
    await vi.advanceTimersByTimeAsync(0);
    read.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read.asks()).toBe(1);
    expect(read.shown).toHaveLength(1);
  });
});

describe("the MCP endpoint, read while General is open", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is read again every 2 s while nothing is served or the read is refused, then not again", async () => {
    vi.useFakeTimers();
    const answers: (McpEndpointStatus | Error)[] = [
      new Error("the Reload services process is restarting; try again in a moment"),
      endpoint(null),
      endpoint("http://127.0.0.1:31010/mcp"),
    ];
    let asks = 0;
    const shown: McpEndpointStatus[] = [];
    const stop = readEndpoint(
      () => {
        const next = answers[Math.min(asks++, answers.length - 1)];
        return next instanceof Error
          ? Promise.reject(next)
          : Promise.resolve(next as McpEndpointStatus);
      },
      (status) => shown.push(status),
      2_000,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(asks).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(asks).toBe(3);
    expect(shown.map(servedAddress)).toEqual([null, "127.0.0.1:31010"]);
    stop();
  });
});

describe("the AI apps section", () => {
  it("tells the address served as host:port, and pre-fills Change port with its port", () => {
    const status = endpoint("http://127.0.0.1:31010/mcp");
    expect(servedAddress(status)).toBe("127.0.0.1:31010");
    expect(servedPort(status)).toBe(31010);
    expect(aiAppsLine(status)).toBe(
      "Claude, Codex and other apps can use your Anytype through Reload at `127.0.0.1:31010`.",
    );
  });

  it("says nothing is served when nothing is, with no port to pre-fill", () => {
    expect(servedAddress(endpoint(null))).toBeNull();
    expect(servedPort(endpoint(null))).toBeNull();
    expect(aiAppsLine(endpoint(null))).toBe(STRINGS["general.aiApps.notServed"]);
  });

  it("words a taken port with ux-writing's line and anything else with the generic one", () => {
    expect(moveRefusal("Error: could not bind 127.0.0.1:40001: EADDRINUSE", 40001)).toBe(
      "Port 40001 is used by another app. Choose another port.",
    );
    expect(moveRefusal("Error: the MCP endpoint setting could not be saved", 40001)).toBe(
      STRINGS["refused.failed"],
    );
  });
});

describe("the AI apps section's host", () => {
  it("pre-fills the host field with the host served, an IPv6 one unbracketed, and nothing when nothing is", () => {
    expect(servedHost(endpoint("http://127.0.0.1:31010/mcp"))).toBe("127.0.0.1");
    expect(servedHost(endpoint("http://[::1]:40001/mcp"))).toBe("::1");
    expect(servedPort(endpoint("http://[::1]:40001/mcp"))).toBe(40001);
    expect(servedHost(endpoint(null))).toBeNull();
  });

  it.each(["0.0.0.0", "::", "192.168.1.2", "localhost", "example.org"])(
    "words the runtime's own refusal of %s with the host line, never as a taken port",
    (host) => {
      // The refusal the services process sends is the endpoint rule's, judged here the same way.
      let reason = "";
      try {
        checkedAddress(host, 40001);
      } catch (error) {
        reason = `Error invoking remote method 'reload:mcp-endpoint-move': ${String(error)}`;
      }
      expect(reason).not.toBe("");
      expect(moveRefusal(reason, 40001)).toBe(STRINGS["general.aiApps.hostRefused"]);
    },
  );

  it("leaves a loopback host of either family to the runtime: the rule passes it", () => {
    expect(checkedAddress("127.0.0.1", 40001)).toEqual({ host: "127.0.0.1", port: 40001 });
    expect(checkedAddress("::1", 40001)).toEqual({ host: "::1", port: 40001 });
  });
});

describe("Copy setup", () => {
  it("copies strings.ts's command with the URL served filled in, and no token", () => {
    const url = "http://127.0.0.1:31010/mcp";
    expect(clientSetup(url)).toBe(STRINGS["general.aiApps.setup"].replace("{url}", url));
    expect(clientSetup(url)).toContain(`--url ${url} `);
    expect(clientSetup(url)).not.toContain("{");
  });
});

describe("Set up ChatGPT (WI-0022-30)", () => {
  it("says ChatGPT's own Add server steps in order, every one a strings.ts line", () => {
    expect(CHATGPT_STEPS.map((key) => STRINGS[key])).toEqual([
      "Open Settings › MCP servers and choose Add server.",
      "Name: reload. Transport: Streamable HTTP.",
      "URL: paste the address. Copy address copies it.",
      "Authentication: Bearer token. Paste the token. Copy token copies it.",
      "Save, then choose Restart.",
    ]);
    expect(STRINGS["general.chatgpt"]).toBe("Set up ChatGPT");
    expect(STRINGS["general.chatgpt.copyAddress"]).toBe("Copy address");
    expect(STRINGS["general.chatgpt.copyToken"]).toBe("Copy token");
  });

  it("no line of it has a slot: neither the address nor the token is ever drawn", () => {
    const keys = Object.keys(STRINGS).filter((key) => key.startsWith("general.chatgpt"));
    expect(keys.length).toBe(12);
    for (const key of keys) {
      expect(STRINGS[key as keyof typeof STRINGS], key).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });
});

describe("the Reports section's state line", () => {
  it("says sending only when on; unanswered is not sending", () => {
    expect(reportsLine("on")).toBe("Sending usage counts.");
    expect(reportsLine("off")).toBe("Not sending.");
    expect(reportsLine("unset")).toBe("Not sending.");
  });
});

/** Which line of the notice tells each signal (plan 0029). */
const SIGNAL_LINES: Readonly<Record<SignalName, PlainKey>> = {
  app_start: "privacy.sent.launches",
  app_stop: "privacy.sent.launches",
  app_unclean_stop: "privacy.sent.launches",
  package_used: "privacy.sent.steps",
  package_error: "privacy.sent.errors",
  mcp_call: "privacy.sent.aiApps",
  flow_deployed: "privacy.sent.flows",
  package_deployed: "privacy.sent.flows",
  package_present: "privacy.sent.launches",
  setup_step: "privacy.sent.setup",
  provider_registered: "privacy.sent.catalogues",
  provider_removed: "privacy.sent.catalogues",
  package_installed: "privacy.sent.installs",
  package_updated: "privacy.sent.installs",
  package_removed: "privacy.sent.installs",
  package_install_failed: "privacy.sent.installs",
  update_offered: "privacy.sent.updates",
  update_applied: "privacy.sent.updates",
};
/** The lines every report carries (`privacy.sent.where`: "the first three"). */
const COMMON_LINES = [
  "privacy.sent.machineId",
  "privacy.sent.versions",
  "privacy.sent.stamp",
] as const satisfies readonly PlainKey[];
/** Each line's fields, each with the words the line says it in: a field is listed with its words. */
const STEP_WORDS = {
  package: ["the package", "only called unsigned"],
  version: ["its version", "with neither its version"],
  source: ["where it came from"],
  signed: ["whether it is signed"],
  environment: ["what it runs on"],
  node_kind: ["the kind and type of the step"],
  node_id: ["type of the step but never its name", "nor its type of step"],
  duration_ms: ["how long it took"],
  ok: ["whether it worked"],
};
const NOTICE_FIELDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "privacy.sent.machineId": { machine_id: ["a machine id", "a keyed hash (HMAC-SHA256)"] },
  "privacy.sent.versions": {
    app_version: ["the Reload version"],
    os: ["your operating system"],
    os_version: ["its version"],
    arch: ["the processor type"],
  },
  "privacy.sent.stamp": {
    kind: ["what kind of report it is"],
    event: ["which of the things below happened"],
    at: ["when it was made"],
    report_id: ["a random number that tells it apart"],
    rules: ["the version of the rules it was checked by"],
  },
  "privacy.sent.launches": {
    startup_ms: ["how long it took to start"],
    packages: ["how many packages are installed"],
    unsigned_packages: ["how many of them are unsigned"],
    package: [
      "each installed package on its own",
      "the package",
      "an unsigned one only as unsigned",
    ],
    version: ["its version if it ships with Reload or is signed"],
    source: ["where it came from"],
    signed: ["whether it is signed"],
    environment: ["what it runs on"],
    uptime_s: ["how long Reload ran"],
    reason: ["why it quit"],
    first_launch: ["whether it is its first start"],
    last_version: ["the version that last ran when it ended without quitting"],
  },
  "privacy.sent.steps": STEP_WORDS,
  "privacy.sent.errors": {
    ...Object.fromEntries(Object.keys(STEP_WORDS).map((field) => [field, ["the same"]])),
    error_type: ["the kind of error when it is a standard one", "any other is only other"],
    file: ["the file", "only when the file is one of the signed package's own"],
    line: ["and line", "the line is in it"],
  },
  "privacy.sent.aiApps": {
    package: ["the Anytype package"],
    version: ["its version"],
    method: ["whether it called a tool or read a file"],
    tool: ["which of Reload's own Anytype tools"],
    client: ["which known AI app it is"],
    duration_ms: ["how long it took"],
    ok: ["whether it worked"],
    error_code: ["the error's code"],
  },
  "privacy.sent.flows": {
    flows: ["how many flows"],
    total_nodes: ["and steps in all"],
    nodes: ["how many steps each flow has with the steps inside its subflows"],
    config_nodes: ["how many configuration nodes"],
    package: ["how many steps of each package"],
  },
  "privacy.sent.setup": { step: ["Reload started", "Anytype paired", "a first flow deployed"] },
  "privacy.sent.catalogues": {
    provider_host: [
      "its server's name only if it is Reload's own",
      "a local one is only file",
      "any other only custom",
    ],
    official: ["whether it is Reload's own"],
    signer_fingerprint: ["a short fingerprint of its signing key"],
    packages_offered: ["how many packages it offers"],
  },
  "privacy.sent.installs": {
    package: ["the package", "an unsigned one only as unsigned"],
    version: ["its versions if it is signed"],
    from_version: ["its versions"],
    provider_host: ["Reload's own catalogue's server name", "another catalogue or a file"],
    source: ["it came from another catalogue or a file"],
    signed: ["whether it is signed"],
    environment: ["what it runs on"],
    node_types: ["how many step types it brings"],
    reason: ["the reason's code, never its words"],
  },
  "privacy.sent.updates": {
    from_version: ["the versions"],
    to_version: ["the versions"],
    channel: ["the update channel"],
  },
};

/** The fields `line` lists. */
function fieldsOf(line: string): readonly string[] {
  return Object.keys(NOTICE_FIELDS[line] ?? {});
}

describe("the privacy notice lists every field of every signal (plan 0029)", () => {
  const listed = PRIVACY_NOTICE.flatMap((part) => part.listed ?? []);
  const built = [...everySignal("x"), ...everySignal("x", false)];
  const common = COMMON_LINES.flatMap(fieldsOf);

  it("names a line for every signal, and every line it names is in the notice", () => {
    expect(Object.keys(SIGNAL_LINES).sort()).toEqual([...SIGNALS].sort());
    expect(Object.keys(NOTICE_FIELDS).sort()).toEqual(
      [...new Set([...COMMON_LINES, ...Object.values(SIGNAL_LINES)])].sort(),
    );
    for (const key of Object.keys(NOTICE_FIELDS)) {
      expect(listed, key).toContain(key);
    }
    expect(STRINGS["privacy.sent.where"]).toContain("Each one carries the first three");
    expect(listed.slice(0, 3)).toEqual(COMMON_LINES);
  });

  it("says every field it lists, in its own words", () => {
    for (const [line, fields] of Object.entries(NOTICE_FIELDS)) {
      for (const [field, words] of Object.entries(fields)) {
        expect(words.length, `${line}: ${field}`).toBeGreaterThan(0);
        for (const word of words) {
          expect(STRINGS[line as PlainKey], `${line}: ${field}: ${word}`).toContain(word);
        }
      }
    }
  });

  it("every field a line lists is one a builder of that line makes: the notice claims nothing more", () => {
    for (const line of new Set(Object.values(SIGNAL_LINES))) {
      const made = new Set(
        built
          .filter((signal) => SIGNAL_LINES[signal.name] === line)
          .flatMap((signal) => Object.keys(signal.fields)),
      );
      for (const field of fieldsOf(line)) {
        expect(made.has(field), `${line} names ${field}, which none of its events carries`).toBe(
          true,
        );
      }
    }
  });

  it("every field that leaves, the builder's and the pipeline's, is one its line or the first three list", async () => {
    expect(new Set(built.map((signal) => signal.name))).toEqual(new Set(SIGNALS));
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    const versions = { appVersion: "1.0.0", os: "darwin", osVersion: "25.3.0", arch: "arm64" };
    for (const signal of built) {
      expect(
        common.some((field) => field in signal.fields),
        signal.name,
      ).toBe(false);
      pipeline.recordUsage(signal.name, { ...versionFields(versions), ...signal.fields });
    }
    await pipeline.flush();
    const sent = world.poster.sent.flatMap((request) =>
      (JSON.parse(request.body) as { payload: { data: Record<string, unknown> } }[]).map(
        (event) => event.payload.data,
      ),
    );
    expect(new Set(sent.map((data) => data["event"]))).toEqual(new Set(SIGNALS));
    const wire = new Set<string>();
    for (const data of sent) {
      const line = SIGNAL_LINES[data["event"] as SignalName];
      for (const key of Object.keys(data)) {
        const field = key.split(".")[0] ?? key;
        wire.add(field);
        expect([...fieldsOf(line), ...common], `${line}: ${key}`).toContain(field);
      }
    }
    // What the pipeline stamps is on the wire, so the first three claim nothing it does not send.
    for (const field of common) {
      expect(wire.has(field), field).toBe(true);
    }
  });

  it("says an error's message is never sent, and lists no message field", () => {
    expect(STRINGS["privacy.never.line"]).toContain("Any error's message.");
    expect(STRINGS["privacy.never.line"]).not.toContain("quotes them");
    expect(STRINGS["privacy.never.line"]).toContain(
      "Your Anytype key or any other key, token or password.",
    );
    const fields = Object.keys(NOTICE_FIELDS).flatMap(fieldsOf);
    expect(fields).not.toContain("error");
    expect(fields).not.toContain("message");
    expect(NOTICE_VERSION).toBe(2);
  });
});

describe("the privacy notice beside the reports question (D25)", () => {
  const keys: readonly PlainKey[] = [
    PRIVACY_NOTICE_OPENING,
    ...PRIVACY_NOTICE.flatMap((part) => [
      part.heading,
      ...part.lines,
      ...(part.listed ?? []),
      ...(part.after ?? []),
    ]),
  ];
  const text = keys.map((key) => STRINGS[key]).join("\n");

  it("is what is sent, what never is, how long it is kept and the GDPR rights, every line a strings.ts line", () => {
    expect(PRIVACY_NOTICE.map((part) => part.heading)).toEqual([
      "privacy.sent",
      "privacy.never",
      "privacy.kept",
      "privacy.rights",
    ]);
    for (const key of keys) {
      expect(STRINGS[key], key).not.toBe("");
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("says only what is true of this version: usage counts to Umami Cloud after a yes, no crash report, nothing before an answer", () => {
    // Where the release sends: Umami Cloud for usage counts, no GlitchTip for crash reports.
    const built = telemetryEndpoints({}, packageJson.reload);
    expect(new URL(built.umamiUrl).hostname).toBe("cloud.umami.is");
    expect(STRINGS["privacy.sent.where"]).toContain("sent to Umami Cloud");
    expect(STRINGS["privacy.sent.address"]).toContain("Umami Cloud your IP address");
    expect(built.glitchtipDsn).toBe("");
    expect(STRINGS["privacy.sent.crashes"]).toBe(
      "Crash reports aren't sent: this version has nowhere to send them.",
    );

    // What a usage count carries: the version set and the packages, the shipped and signed ones
    // by name and version, the unsigned ones only counted.
    const versions = { appVersion: "0.3.0", os: "darwin", osVersion: "25.3.0", arch: "arm64" };
    const { named, unsigned } = reportedPackages([
      { name: "anytype", document: { version: "1.2.0" }, installed: false, signed: false },
      { name: "probekit", document: { version: "0.3.0" }, installed: true, signed: true },
      { name: "my-own", document: { version: "0.0.1" }, installed: true, signed: false },
    ]);
    expect(named.map((entry) => entry.id)).toEqual(["anytype", "probekit"]);
    expect(unsigned).toBe(1);
    expect(STRINGS["privacy.sent.launches"]).toContain("how many of them are unsigned");
    expect(STRINGS["privacy.sent.launches"]).toContain("an unsigned one only as unsigned");
    // No event carries the package list any more: the notice no longer says each one does.
    expect(STRINGS["privacy.sent.where"]).toContain("Each one carries the first three");
    const start = appStart({
      startupMs: 900,
      packages: named.length,
      unsignedPackages: 0,
      firstLaunch: false,
    });
    const payload = { ...versionFields(versions), packages: start.fields["packages"] as Json };
    expect(Object.keys(payload).sort()).toEqual([
      "app_version",
      "arch",
      "os",
      "os_version",
      "packages",
    ]);
    expect(STRINGS["privacy.sent.versions"]).toBe(
      "the Reload version, your operating system, its version and the processor type",
    );

    // Sending wraps a report, adding only the version and values the same on every computer.
    const sent = (machineId: string) => {
      const outgoing = outgoingFor(
        {
          sequence: 1,
          kind: "usage",
          payload: { ...payload, unsigned_packages: unsigned, machine_id: machineId },
        },
        built,
        "0.3.0",
      );
      const body = JSON.parse(outgoing.body) as { payload: Record<string, unknown> };
      return { headers: outgoing.headers, body };
    };
    const one = sent("a".repeat(64));
    const other = sent("b".repeat(64));
    expect(one.headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "reload/0.3.0",
    });
    expect(one.body.payload).toMatchObject({
      website: packageJson.reload.umamiWebsiteId,
      hostname: UMAMI_HOSTNAME,
      url: UMAMI_URL_PATH,
      name: "usage",
      data: flatten({ ...payload, unsigned_packages: unsigned, machine_id: "a".repeat(64) }),
    });
    expect({ ...one.body.payload, data: null }).toEqual({ ...other.body.payload, data: null });
    expect(one.headers).toEqual(other.headers);
    expect(STRINGS["privacy.sent.wrapped"]).toContain(
      "adding only the Reload version and values that are the same on every computer",
    );
    expect(STRINGS["privacy.rights.see"]).toContain(
      "shows what each report carries before it is sent",
    );

    for (const needed of [
      "optional",
      "keyed hash (HMAC-SHA256)",
      "never leaves this computer",
      "Anytype content",
      "user name",
      "raw identifier",
      "GDPR",
      "pseudonymous personal data",
      "no name, email or account",
      "Nothing is sent until you answer.",
      "stops all sending at once and deletes anything still waiting",
    ]) {
      expect(text, needed).toContain(needed);
    }
    // How long, and who answers: the retention the domain names; the copyright holder (LICENSE).
    expect(STRINGS["privacy.kept.line"]).toBe(
      `Umami Cloud keeps usage counts for ${String(USAGE_RETENTION_MONTHS)} months, then deletes them.`,
    );
    const licence = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "..", "LICENSE"),
      "utf8",
    );
    expect(licence).toContain("Copyright (c) 2026 Re:Circuit Cooperative");
    expect(STRINGS["privacy.rights.contact"]).toContain(
      "Re:Circuit Cooperative, who make Reload, at privacy@recircu.it",
    );
    // Nothing the code does not do: the earlier claims that were not true of this version.
    for (const untrue of [
      "anonymous",
      "can't be matched",
      "exactly as it would leave",
      "13 months",
      "kept only that long",
      "picked out",
    ]) {
      expect(text, untrue).not.toContain(untrue);
    }
  });

  it("is shown in General › Reports only while the question is unanswered", () => {
    expect(showsPrivacyNotice("unset")).toBe(true);
    expect(showsPrivacyNotice("on")).toBe(false);
    expect(showsPrivacyNotice("off")).toBe(false);
  });
});

describe("retention (D8)", () => {
  it("offers 7, 30, 90, 365 days and Forever, in that order, and reads each back", () => {
    expect(RETENTION_OPTIONS.map((option) => option.label)).toEqual([
      "7 days",
      "30 days",
      "90 days",
      "365 days",
      "Forever",
    ]);
    for (const days of [7, 30, 90, 365, null]) {
      expect(retentionDays(retentionValue(days))).toBe(days);
    }
    expect(retentionDays("14")).toBeUndefined();
  });

  it("states how long runs are kept", () => {
    expect(retentionLine(90)).toBe("Runs are kept for 90 days.");
    expect(retentionLine(null)).toBe("Runs are kept until you delete them.");
  });
});

describe("Recorders and folders", () => {
  const flow = (id: string, on: boolean, sources: FlowSummary["sources"]): FlowSummary => ({
    id,
    name: id,
    template: null,
    on,
    health: { kind: "ready" },
    lastRun: null,
    viewNodes: [],
    steps: [],
    sources,
  });
  const step = (id: string, type: string, setUp = true) => ({ id, name: id, type, setUp });

  it("finds every folder source that is set up, with its flow's switch", () => {
    expect(
      folderSteps([
        flow("a", true, [
          step("w1", FOLDER_SOURCE_TYPE),
          step("f1", "reload-reload_anytype-create-object"),
        ]),
        flow("b", false, [step("w2", FOLDER_SOURCE_TYPE), step("w3", FOLDER_SOURCE_TYPE, false)]),
      ]),
    ).toEqual([
      { flowId: "a", nodeId: "w1", on: true },
      { flowId: "b", nodeId: "w2", on: false },
    ]);
    expect(
      folderSteps([flow("c", true, [step("x", "reload-reload_anytype-create-object")])]),
    ).toEqual([]);
  });

  it("names a folder by its own name, never its path, watching or not", () => {
    expect(folderName("/Volumes/BOYA")).toBe("BOYA");
    expect(folderName("/Users/me/Recordings/")).toBe("Recordings");
    expect(folderName("C:\\Users\\me\\Inbox")).toBe("Inbox");
    expect(recorderLine("/Volumes/BOYA", true)).toBe("BOYA · watching");
    expect(recorderLine("/Volumes/BOYA", false)).toBe("BOYA · not watching: its flow is off");
  });
});

describe("a line with code in it", () => {
  it("marks the backticked part as code and drops the backticks", () => {
    expect(codeParts("apps reach it at `127.0.0.1:31010`.")).toEqual([
      { code: false, text: "apps reach it at " },
      { code: true, text: "127.0.0.1:31010" },
      { code: false, text: "." },
    ]);
    expect(codeParts("no code")).toEqual([{ code: false, text: "no code" }]);
  });
});

describe("Packages (plan 0022 §F)", () => {
  const at = new Date(2026, 9, 14, 9, 14);
  const view = (updates: number): PackagesView => ({
    offers: [],
    packages: ["anytype", "folder", "monty", "reload_summarize"].map((name, index) => ({
      publisher: null,
      actions: { enabled: [], disabled: [] },
      package: {
        name,
        version: "0.3",
        source: { kind: "catalogue" },
        signed: true,
        shipped: false,
        registration: null,
        installation: null,
        update:
          index < updates
            ? { state: "available", version: "0.4", verifiedAt: at }
            : { state: "up-to-date", verifiedAt: at },
      },
    })),
  });

  it("the state line: '4 installed · 1 update', and no count of none", () => {
    expect(packagesLine(view(1))).toBe("4 installed · 1 update");
    expect(packagesLine(view(2))).toBe("4 installed · 2 updates");
    expect(packagesLine(view(0))).toBe("4 installed");
  });

  it("every state says when it was checked: 'checked today 09:14'", () => {
    expect(wordChecked(at, new Date(2026, 9, 14, 17, 0))).toBe("checked today 09:14");
    expect(wordChecked(at, new Date(2026, 9, 15, 8, 0))).toBe("checked yesterday 09:14");
  });

  it("a name between asterisks is a name; a title without italics drops them", () => {
    expect(nameParts("Can't unregister *monty*: no.")).toEqual([
      { name: false, text: "Can't unregister " },
      { name: true, text: "monty" },
      { name: false, text: ": no." },
    ]);
    expect(withoutMarks("Go back to *monty* 0.3?")).toBe("Go back to monty 0.3?");
  });
});

describe("every action a Package row draws has its call", () => {
  const at = new Date(2026, 9, 14, 9, 14);
  const installation = (state: Installation["state"]): Installation =>
    state === "installing"
      ? { state, progress: 50, verifiedAt: at }
      : state === "failed-check"
        ? { state, reason: "content-moved", verifiedAt: at }
        : { state, verifiedAt: at };
  const update = (state: PackageUpdate["state"]): PackageUpdate =>
    state === "updated"
      ? {
          state,
          version: "0.4",
          previous: "0.3",
          at,
          rollbackUntil: new Date(2026, 9, 20),
          verifiedAt: at,
        }
      : state === "up-to-date"
        ? { state, verifiedAt: at }
        : state === "blocked"
          ? { state, version: "0.4", reason: "it sent no ready", rolledBack: true, verifiedAt: at }
          : { state, version: "0.4", verifiedAt: at };
  const sources: Package["source"][] = [
    { kind: "catalogue" },
    { kind: "folder", path: "/p" },
    { kind: "folder", path: "/p", unreadable: true },
  ];
  /** Every call a press can make, recorded by the method it reached. */
  const called: string[] = [];
  const api = new Proxy({} as AppApiV2, {
    get: (_target, method: string) => () => {
      called.push(method);
      return Promise.resolve({ ok: true, value: null });
    },
  });

  it("on every state, source, registration and shipping, each drawn action reaches its call", async () => {
    let drawn = 0;
    for (const source of sources)
      for (const shipped of [false, true])
        for (const registered of ["registered", "not-registered"] as const)
          for (const inst of INSTALLATION_STATES)
            for (const upd of [...PACKAGE_UPDATE_STATES, null]) {
              const pkg: Package = {
                name: "monty",
                version: "0.3",
                source,
                signed: true,
                shipped,
                registration: { state: registered, verifiedAt: at },
                installation: installation(inst),
                update: upd === null ? null : update(upd),
              };
              const { enabled, disabled } = rowActions(pkg, at);
              for (const action of [...enabled, ...disabled]) {
                drawn += 1;
                const what = PACKAGE_ACTIONS[action](api, pkg.name);
                if (what.kind === "call") {
                  called.length = 0;
                  await what.call();
                  expect(called, `${action} reaches one call`).toHaveLength(1);
                }
              }
              // A shipped package that failed its check offers neither Install nor Remove.
              if (shipped && inst === "failed-check") {
                expect([...enabled, ...disabled]).not.toContain("install");
                expect([...enabled, ...disabled]).not.toContain("remove");
              }
            }
    expect(drawn).toBeGreaterThan(0);
  });

  it("each action reaches the call that does it", async () => {
    const reached: Record<string, string> = {};
    for (const [action, press] of Object.entries(PACKAGE_ACTIONS)) {
      const what = press(api, "monty");
      called.length = 0;
      if (what.kind === "call") await what.call();
      reached[action] = what.kind === "call" ? (called[0] ?? "") : "confirm-go-back";
    }
    expect(reached).toEqual({
      register: "registerPackage",
      unregister: "unregisterPackage",
      install: "reinstallPackage",
      remove: "uninstallPackage",
      update: "updatePackage",
      "check-for-changes": "checkFolder",
      "go-back": "confirm-go-back",
    });
  });
});

describe("Stability defaults (plan 0031, the old helper form's six numbers)", () => {
  const values = {
    memory_mb: 1024,
    cpu_percent: 90,
    cpu_window_s: 120,
    open_files: 1024,
    children: 32,
    grace_s: 60,
  };

  it("asks for all six limits, each with its strings.ts label, the two counts whole", () => {
    expect(LIMIT_FIELDS.map((field) => field.key)).toEqual(Object.keys(values));
    expect(LIMIT_FIELDS.filter((field) => field.whole).map((field) => field.key)).toEqual([
      "open_files",
      "children",
    ]);
    for (const field of LIMIT_FIELDS) {
      expect(STRINGS[field.label]).toBeTruthy();
    }
  });

  it("shows the values in force, and sends what was typed, an empty field as zero for the shell to refuse", () => {
    const typed = limitsTyped(values);
    expect(typed.memory_mb).toBe("1024");
    expect(limitsToSave({ ...typed, memory_mb: "2048.5", grace_s: " " })).toEqual({
      ...values,
      memory_mb: 2048.5,
      grace_s: 0,
    });
  });

  it("says what is wrong with each refused field, and what to enter", () => {
    const errors = limitErrors({
      reason: "invalid",
      sentence: "general.limits.refused",
      problems: [
        { path: "children", message: "not-whole" },
        { path: "grace_s", message: "not-positive" },
        { path: "memory_mb", message: "too-large" },
        { path: "nonsense", message: "not-a-limit" },
      ],
    });
    expect(errors).toEqual({
      children: STRINGS["general.limits.notWhole"],
      grace_s: STRINGS["general.limits.notPositive"],
      memory_mb: STRINGS["general.limits.tooLarge"],
    });
    expect(limitErrors({ reason: "failed", sentence: "refused.failed" })).toEqual({});
  });
});
