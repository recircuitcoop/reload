// What a telemetry report is and what it may carry (plan 0018 §3 telemetry.py: Port; the
// consent-first design of plan 0003 F2, kept whole). What the person is told before any is sent
// is the privacy notice, worded in ui/strings.ts and laid out by ui/general.ts.
//
// The reports are assembled from named fields, never from whatever a caller hands over: a usage
// report says which version runs where and which packages are installed; a crash report says
// which process crashed and how often each has. Adding a field here is the moment somebody has to
// ask whether it may be sent.

import { hostOnly, WITHHELD, type JsonObject } from "./redact";
import type { HeldSources } from "./sources";
import {
  CHANNELS,
  clientOf,
  errorCodeOf,
  errorTypeOf,
  HOST,
  IDENTIFIER,
  INSTALL_REFUSALS,
  known,
  shaped,
  stepFile,
  VERSION,
} from "./vocabulary";

/** The two kinds of report, which go to two different servers (D21, D22). */
export type ReportKind = "usage" | "error";

export const REPORT_KINDS: readonly ReportKind[] = ["usage", "error"];

export function isReportKind(value: unknown): value is ReportKind {
  return value === "usage" || value === "error";
}

/**
 * The switch. `on` is the only answer that queues or sends; `off` and `unset` both stop everything,
 * and `unset` is the question not answered yet (F2: nothing at all before the person was asked).
 */
export type TelemetryAnswer = "on" | "off" | "unset";

/** Telemetry cannot be set up, naming what is missing. Never raised to a caller that reported. */
export class TelemetryError extends Error {
  override name = "TelemetryError";
}

/** One report waiting in the queue, already redacted. */
export interface QueuedReport {
  readonly sequence: number;
  readonly kind: ReportKind;
  readonly payload: JsonObject;
}

// ── the machine id's input ───────────────────────────────────────────────────────────────

/**
 * An identifier shorter than this is not the OS's machine identifier: a stub, a fake or a
 * truncated read. Registering it with the redactor would blank fragments of unrelated text.
 */
export const MINIMUM_IDENTIFIER_LENGTH = 8;

/** The raw identifier, checked: refused when empty or too short to be the OS's own. */
export function checkIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new TelemetryError(
      "the machine identifier source returned nothing; telemetry needs the operating system's " +
        "own machine identifier to derive a machine id",
    );
  }
  if (trimmed.length < MINIMUM_IDENTIFIER_LENGTH) {
    throw new TelemetryError(
      `the machine identifier source returned ${String(trimmed.length)} characters, which is ` +
        `not an operating system machine identifier (at least ` +
        `${String(MINIMUM_IDENTIFIER_LENGTH)} are expected)`,
    );
  }
  return trimmed;
}

// ── what is sent ─────────────────────────────────────────────────────────────────────────

/** One installed package as usage reports it: which package, which version. */
export interface ReportedPackage {
  readonly id: string;
  readonly version: string;
}

// The version fields and the crash reports, each in their own file.
export { versionFields, type Versions } from "./vocabulary";
export { crashPayload, CRASH_TYPES, type CrashCounts, type CrashedProcess } from "./crashes";

// ── the signals (plan 0029) ──────────────────────────────────────────────────────────────
//
// One Umami event per signal, named as the signal. Each builder below makes its fields from named
// inputs and nothing else (plan 0029 rule 1): no node config, no message payload, no MCP tool's
// arguments or result, no header, environment variable or settings value. A URL becomes its host
// (rule 3), and a package nobody signed is counted, never named.
//
// No free text, ever: free text cannot be proved credential-free, so no event carries an error's
// message or any other text a package or a person wrote. Every string a package or a person could
// choose is an identifier checked against a strict shape (`shaped`, below): a package name, a
// version, a type id, a tool name, a host, a relative source file, an error's class name, an MCP
// client's name. A value outside its shape is sent as "[withheld]", never cut to fit; what passes
// still goes through the pipeline's redaction and scrub.

export const SIGNALS = [
  "app_start",
  "app_stop",
  "app_unclean_stop",
  "package_used",
  "package_error",
  "mcp_call",
  "flow_deployed",
  "package_deployed",
  "package_present",
  "setup_step",
  "provider_registered",
  "provider_removed",
  "package_installed",
  "package_updated",
  "package_removed",
  "package_install_failed",
  "update_offered",
  "update_applied",
] as const;

export type SignalName = (typeof SIGNALS)[number];

export function isSignalName(value: unknown): value is SignalName {
  return SIGNALS.includes(value as SignalName);
}

/** One signal's event: its name and its own fields, before the version fields join them. */
export interface Signal {
  readonly name: SignalName;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The version of the privacy notice a yes answers. A yes given to an older notice is asked again
 * (plan 0029 WI-07): what a yes covers changed when the signals came.
 */
export const NOTICE_VERSION = 2;

/**
 * Fields whose NAMES the one redaction would blank (`file`, `env`, `host`, `config`), and whose
 * values the builders make from a closed form: a path the package holds, one of three environment
 * kinds, a hostname, a count. Their text still passes the credential removal, the path reduction
 * and the scrub.
 */
export const VOUCHED_FIELDS: readonly string[] = [
  "file",
  "environment",
  "provider_host",
  "config_nodes",
];

/** What an unsigned package is called in every event: its own name is its author's free text. */
export const UNSIGNED = "unsigned";

/** Where a package came from. */
export type PackageSource = "shipped" | "catalogue" | "file";
export type PackageEnvironmentKind = "uv-python" | "node" | "executable";

/** A package as the app knows it, before the unsigned rule decides what of it is named. */
export interface PackageFacts {
  readonly package: string;
  readonly version: string;
  readonly source: PackageSource;
  readonly signed: boolean;
  /** Null for a shipped package that declares none. */
  readonly environment: PackageEnvironmentKind | null;
  /** The type ids its declaration lists: a step's `node_id` is sent only when it is one. */
  readonly nodeTypes?: readonly string[];
  /** Its source files and line counts, as its verified files gave them (domain/telemetry/sources). */
  readonly held?: HeldSources;
}

/** The package fields of an event: an unsigned package is `unsigned`, with no version. */
function packageFields(facts: PackageFacts): Record<string, unknown> {
  return {
    package: facts.signed ? shaped(facts.package, IDENTIFIER) : UNSIGNED,
    version: facts.signed ? shaped(facts.version, VERSION) : null,
    source: facts.source,
    signed: facts.signed,
    environment: facts.environment,
  };
}

/** A whole, non-negative count of milliseconds or seconds; 0 for anything else. */
function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A source line: a whole number from 1; null for anything else. */
export function lineOf(line: unknown): number | null {
  return typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= 10_000_000
    ? line
    : null;
}

/** One packaged node's step, as the runtime timed it. */
export interface StepFacts {
  readonly nodeKind: "source" | "node" | "view";
  /** The type's declared id, never the instance's. */
  readonly nodeId: string;
  readonly durationMs: number;
  readonly ok: boolean;
}

/**
 * Where a step failed, as its SDK said it; every field may be missing. Never its message: the
 * message stays in the app's own log and on the canvas.
 */
export interface StepFailure {
  readonly errorType: string | null;
  readonly file: string | null;
  readonly line: number | null;
}

/**
 * `app_start`: every launch, after the children are up, with how many packages are installed;
 * each one is its own `package_present` beside it, never a list Umami would cut.
 */
export function appStart(facts: {
  readonly startupMs: number;
  readonly packages: number;
  readonly unsignedPackages: number;
  readonly firstLaunch: boolean;
}): Signal {
  return {
    name: "app_start",
    fields: {
      startup_ms: whole(facts.startupMs),
      packages: facts.packages,
      unsigned_packages: facts.unsignedPackages,
      first_launch: facts.firstLaunch,
    },
  };
}

/** `package_present`: at every launch, one per installed package. */
export function packagePresent(facts: PackageFacts): Signal {
  return { name: "package_present", fields: packageFields(facts) };
}

export type StopReason = "quit" | "update";

/** `app_stop`: every quit, queued before the children stop. */
export function appStop(uptimeS: number, reason: StopReason): Signal {
  return { name: "app_stop", fields: { uptime_s: whole(uptimeS), reason } };
}

/** `app_unclean_stop`: at start, when the last launch left no `app_stop`. */
export function appUncleanStop(lastVersion: string): Signal {
  return { name: "app_unclean_stop", fields: { last_version: shaped(lastVersion, VERSION) } };
}

function stepFields(facts: PackageFacts, step: StepFacts): Record<string, unknown> {
  return {
    ...packageFields(facts),
    node_kind: step.nodeKind,
    // A type id is its author's words too: an unsigned package's is not named either.
    // Only a type the signed package declares is named: anything else is `unsigned`.
    node_id: facts.signed
      ? facts.nodeTypes?.includes(step.nodeId) === true
        ? shaped(step.nodeId, IDENTIFIER)
        : UNSIGNED
      : null,
    duration_ms: whole(step.durationMs),
    ok: step.ok,
  };
}

/** `package_used`: every time a node of a package runs one step. */
export function packageUsed(facts: PackageFacts, step: StepFacts): Signal {
  return { name: "package_used", fields: stepFields(facts, step) };
}

/**
 * `package_error`: every time such a step, or a source, fails: the type of the error and where it
 * was thrown, never its message. An unsigned package's file is its author's path: only the line
 * is sent.
 */
export function packageError(facts: PackageFacts, step: StepFacts, failure: StepFailure): Signal {
  return {
    name: "package_error",
    fields: {
      ...stepFields(facts, { ...step, ok: false }),
      error_type: errorTypeOf(failure.errorType),
      ...whereIn(facts, failure),
    },
  };
}

/**
 * A failure's `file` and `line`, only as the signed package's verified files hold them: a file it
 * does not hold, or a line past that file's last, is withheld, whatever its form. An unsigned
 * package's file is its author's path: neither is sent.
 */
function whereIn(facts: PackageFacts, failure: StepFailure): Record<string, unknown> {
  const line = lineOf(failure.line);
  if (!facts.signed) {
    return { file: null, line: line === null ? null : WITHHELD };
  }
  const file = stepFile(failure.file);
  const lines = file !== null && Object.hasOwn(facts.held ?? {}, file) ? facts.held?.[file] : null;
  return {
    file: file === null ? null : lines === null || lines === undefined ? WITHHELD : file,
    line:
      line === null
        ? null
        : lines !== null && lines !== undefined && line <= lines
          ? line
          : WITHHELD,
  };
}

/** The MCP requests that do a client's work: each one is an `mcp_call`. */
export const MCP_WORK = ["tools/call", "resources/read"] as const;
export type McpWork = (typeof MCP_WORK)[number];

/** One request that did a client's work on the loopback endpoint, as the services process saw it. */
export interface McpCallFacts {
  readonly method: McpWork;
  /** A tools/call's tool, only when the validated set holds it; null for a resources/read. */
  readonly tool: string | null;
  readonly client: string | null;
  readonly durationMs: number;
  readonly ok: boolean;
  /** The JSON-RPC error's code; null for a result. */
  readonly errorCode: number | null;
}

/** The package that answers the loopback MCP endpoint. */
export const MCP_PACKAGE = "reload_anytype";

/** `mcp_call`: every tools/call and resources/read on the loopback endpoint. */
export function mcpCall(version: string | null, call: McpCallFacts): Signal {
  return {
    name: "mcp_call",
    fields: {
      package: MCP_PACKAGE,
      version: shaped(version, VERSION),
      method: call.method,
      // Lowercased: a long capitalised name (`API-get-collection-views`) would read as a key to
      // the scrub, which every string passes, this one too.
      tool: shaped(call.tool?.toLowerCase(), IDENTIFIER),
      client: clientOf(call.client),
      duration_ms: whole(call.durationMs),
      ok: call.ok,
      error_code: errorCodeOf(call.errorCode),
    },
  };
}

/** How many nodes one package has in the deployed flows. */
export interface PackageCount {
  readonly package: string;
  readonly nodes: number;
}

/**
 * `flow_deployed` and `package_deployed`: every deploy, with exact counts (the owner makes the
 * buckets). One `flow_deployed` per flow, its own node count (subflow instances' insides
 * included) beside the deploy's totals and its config nodes, and one `package_deployed` per
 * package: Umami cuts an array to 500 characters, so no count is ever sent as a list. A deploy of
 * no flows tells nothing.
 */
export function flowDeployed(
  nodesPerFlow: readonly number[],
  perPackage: readonly PackageCount[],
  configNodes = 0,
): Signal[] {
  const flows = nodesPerFlow.length;
  const total = nodesPerFlow.reduce((sum, count) => sum + count, 0);
  // A deploy of no flows tells nothing: there is no flow to count.
  return [
    ...nodesPerFlow.map((nodes): Signal => ({
      name: "flow_deployed",
      fields: { flows, total_nodes: total, nodes, config_nodes: configNodes },
    })),
    ...perPackage.map((entry): Signal => ({
      name: "package_deployed",
      fields: { package: shaped(entry.package, IDENTIFIER), nodes: entry.nodes },
    })),
  ];
}

export const SETUP_STEPS = ["launched", "anytype_paired", "first_flow_deployed"] as const;
export type SetupStepReached = (typeof SETUP_STEPS)[number];

/** `setup_step`: each first-run step reached. */
export function setupStep(step: SetupStepReached): Signal {
  return { name: "setup_step", fields: { step } };
}

/** A catalogue a package can come from, as the provider events see it. */
export interface ProviderFacts {
  /** Its address: only its host is sent (rule 3). */
  readonly url: string;
  /** The catalogue shipped with the app. */
  readonly official: boolean;
}

/**
 * A provider's host as sent (rule 3): the official catalogue's host, `file` for a local source,
 * and `custom` for every other: a host somebody registered is theirs to name, so it is not sent.
 * Null when there is no address.
 */
export function providerHost(url: string | null, official: boolean): string | null {
  if (url === null) {
    return null;
  }
  if (url.toLowerCase().startsWith("file:")) {
    return "file";
  }
  return official ? shaped(hostOnly(url), HOST) : "custom";
}

/** `provider_registered`: a package provider (catalogue) is added. */
export function providerRegistered(
  provider: ProviderFacts,
  signerFingerprint: string | null,
  packagesOffered: number,
): Signal {
  return {
    name: "provider_registered",
    fields: {
      provider_host: providerHost(provider.url, provider.official),
      official: provider.official,
      // The public signing key's fingerprint, hex: never the key, nor anything secret.
      signer_fingerprint:
        signerFingerprint !== null && /^[0-9a-f]{1,12}$/.test(signerFingerprint)
          ? signerFingerprint
          : null,
      packages_offered: packagesOffered,
    },
  };
}

/** `provider_removed`: a provider is removed; the telemetry memory kept only its host as sent. */
export function providerRemoved(
  provider: { readonly host: string | null; readonly official: boolean },
  officialHost: string | null,
): Signal {
  const { host } = provider;
  return {
    name: "provider_removed",
    fields: {
      // The memory is a file on disk: its host is sent only when it is the build's catalogue's.
      provider_host:
        host === null || host === "file" ? host : host === officialHost ? host : "custom",
      official: provider.official,
    },
  };
}

/** Where an install came from: a catalogue's address, or a file on this machine (never named). */
export type InstallOrigin =
  | { readonly kind: "catalogue"; readonly url: string | null; readonly official: boolean }
  | { readonly kind: "file" };

function installFields(
  facts: PackageFacts,
  origin: InstallOrigin,
  nodeTypes: number,
): Record<string, unknown> {
  return {
    ...packageFields(facts),
    provider_host: origin.kind === "file" ? "file" : providerHost(origin.url, origin.official),
    node_types: nodeTypes,
  };
}

/** `package_installed`: every install, once it is live. */
export function packageInstalled(
  facts: PackageFacts,
  origin: InstallOrigin,
  nodeTypes: number,
): Signal {
  return { name: "package_installed", fields: installFields(facts, origin, nodeTypes) };
}

/** `package_updated`: every update, once it is live. */
export function packageUpdated(
  facts: PackageFacts,
  origin: InstallOrigin,
  nodeTypes: number,
  fromVersion: string,
): Signal {
  return {
    name: "package_updated",
    fields: {
      ...installFields(facts, origin, nodeTypes),
      from_version: facts.signed ? shaped(fromVersion, VERSION) : null,
    },
  };
}

/** `package_removed`: every removal. */
export function packageRemoved(facts: PackageFacts): Signal {
  const { package: name, version, source, signed } = packageFields(facts);
  return { name: "package_removed", fields: { package: name, version, source, signed } };
}

/** `package_install_failed`: a refused or failed install, with the refusal's code, never its text. */
export function packageInstallFailed(origin: InstallOrigin, reason: string): Signal {
  return {
    name: "package_install_failed",
    fields: {
      source: origin.kind,
      provider_host: origin.kind === "file" ? "file" : providerHost(origin.url, origin.official),
      reason: known(reason, INSTALL_REFUSALS),
    },
  };
}

/** `update_offered` / `update_applied`: the updater found, or installs, another version. */
export function updateSignal(
  name: "update_offered" | "update_applied",
  fromVersion: string,
  toVersion: string,
  channel: string,
): Signal {
  return {
    name,
    fields: {
      from_version: shaped(fromVersion, VERSION),
      to_version: shaped(toVersion, VERSION),
      channel: known(channel, CHANNELS),
    },
  };
}

/**
 * What the runtime and the services process tell the shell about a signal (the `signal` channel
 * message): the facts only. The shell names the package and builds the event. A `step` is one
 * use (a step a node ran, or a run a source started); a `source-error` is a source's failure
 * outside any step, an error and no use.
 */
export type ChildSignal =
  | {
      readonly kind: "step" | "source-error";
      readonly package: string;
      readonly step: StepFacts;
      readonly failure: StepFailure | null;
    }
  | { readonly kind: "mcp-call"; readonly call: McpCallFacts }
  | {
      readonly kind: "deployed";
      readonly nodesPerFlow: readonly number[];
      readonly perPackage: readonly PackageCount[];
      /** Config nodes, which sit on no flow: counted on their own. */
      readonly configNodes: number;
    };

// ── retention ────────────────────────────────────────────────────────────────────────────

/**
 * How long usage counts are kept, named so the notice and any server configuration read the same:
 * Umami Cloud's Hobby plan keeps them 6 months (owner, 2026-10-15).
 */
export const USAGE_RETENTION_MONTHS = 6;
