// What a telemetry report is and what it may carry (plan 0018 §3 telemetry.py: Port; the
// consent-first design of plan 0003 F2, kept whole). What the person is told before any is sent
// is the privacy notice, worded in ui/strings.ts and laid out by ui/general.ts.
//
// The reports are assembled from named fields, never from whatever a caller hands over: a usage
// report says which version runs where and which packages are installed; a crash report says
// which process crashed and how often each has. Adding a field here is the moment somebody has to
// ask whether it may be sent.

import { hostOnly, type JsonObject } from "./redact";

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

/** Which version runs, on what. Every report carries it. */
export interface Versions {
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly arch: string;
}

/** One installed package as usage reports it: which package, which version. */
export interface ReportedPackage {
  readonly id: string;
  readonly version: string;
}

/** The version fields every report carries; each signal's own fields go beside them. */
export function versionFields(versions: Versions): Record<string, string> {
  return {
    app_version: versions.appVersion,
    os: versions.os,
    os_version: versions.osVersion,
    arch: versions.arch,
  };
}

/** One usage report's body, before redaction: the version set and the packages installed. */
export function usagePayload(
  versions: Versions,
  packages: readonly ReportedPackage[],
): Record<string, unknown> {
  return {
    ...versionFields(versions),
    packages: packages.map((entry) => ({ id: entry.id, version: entry.version })),
  };
}

/** The processes whose crashes are counted: the two supervised children and a node's process. */
export type CrashedProcess = "runtime" | "services" | "node";

/** How often each has crashed since the app started. */
export interface CrashCounts {
  readonly runtime: number;
  readonly services: number;
  readonly node: number;
  /** Node instances the crash-loop limit stopped. */
  readonly nodeStopped: number;
}

/** The exception type a crash is grouped under on the error server. */
export const CRASH_TYPES: Readonly<Record<CrashedProcess, string>> = {
  runtime: "RuntimeCrashed",
  services: "ServicesCrashed",
  node: "NodeProcessCrashed",
};

/**
 * One crash report's body, before redaction: which process crashed, whether the crash-loop limit
 * stopped it, and the counts. Never what the process was working on: no node's name, no input, no
 * message, no log line (plan 0003: an error report never carries the exception's message).
 */
export function crashPayload(
  crashed: CrashedProcess,
  stoppedForGood: boolean,
  counts: CrashCounts,
  versions: Versions,
): Record<string, unknown> {
  return {
    ...versionFields(versions),
    exception_type: CRASH_TYPES[crashed],
    crashed,
    stopped_for_good: stoppedForGood,
    crashes: {
      runtime: counts.runtime,
      services: counts.services,
      node: counts.node,
      node_stopped: counts.nodeStopped,
    },
  };
}

// ── the signals (plan 0029) ──────────────────────────────────────────────────────────────
//
// One Umami event per signal, named as the signal. Each builder below makes its fields from named
// inputs and nothing else (plan 0029 rule 1): no node config, no message payload, no MCP tool's
// arguments or result, no header, environment variable or settings value. A URL becomes its host
// (rule 3), a package nobody signed is counted, never named, and the only free text is a failed
// step's message and an MCP client's name, which the pipeline scrubs or withholds (rule 4).

export const SIGNALS = [
  "app_start",
  "app_stop",
  "app_unclean_stop",
  "package_used",
  "package_error",
  "mcp_call",
  "flow_deployed",
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
 * Fields whose NAMES the one redaction would blank (`file`, `env`, `host`), and whose values the
 * builders make from a closed form: a path relative to its package (`stepFile`), one of three
 * environment kinds, a hostname (`hostOnly`). Their text still passes the credential removal,
 * the path reduction and the scrub.
 */
export const VOUCHED_FIELDS: readonly string[] = ["file", "environment", "provider_host"];

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
}

/** The package fields of an event: an unsigned package is `unsigned`, with no version. */
function packageFields(facts: PackageFacts): Record<string, unknown> {
  return {
    package: facts.signed ? facts.package : UNSIGNED,
    version: facts.signed ? facts.version : null,
    source: facts.source,
    signed: facts.signed,
    environment: facts.environment,
  };
}

/** A whole, non-negative count of milliseconds or seconds; 0 for anything else. */
function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A path relative to its package's folder, in the SDKs' form: `src/node.py`, never `..`. */
const RELATIVE_FILE = /^[\w.+@-]+(?:\/[\w.+@-]+)*$/;
export const MAX_FILE_LENGTH = 200;

/** A step's `file`, when it is a plain path inside its package; null for anything else. */
export function stepFile(file: unknown): string | null {
  if (typeof file !== "string" || file.length > MAX_FILE_LENGTH || !RELATIVE_FILE.test(file)) {
    return null;
  }
  return file.split("/").some((segment) => segment === "." || segment === "..") ? null : file;
}

/** An exception's class name (`ZeroDivisionError`, `anytype.ApiError`); null for anything else. */
export function errorTypeOf(type: unknown): string | null {
  return typeof type === "string" && /^[A-Za-z_$][\w$.]{0,99}$/.test(type) ? type : null;
}

/** A source line: a whole number from 1; null for anything else. */
export function lineOf(line: unknown): number | null {
  return typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= 10_000_000
    ? line
    : null;
}

/** An MCP client's `clientInfo.name`, cut to 40 characters; null when it gave none. */
export const MAX_CLIENT_LENGTH = 40;
export function clientOf(name: unknown): string | null {
  return typeof name === "string" && name.trim() !== ""
    ? name.trim().slice(0, MAX_CLIENT_LENGTH)
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

/** Why a step failed, as its SDK said it; every field may be missing. */
export interface StepFailure {
  readonly errorType: string | null;
  readonly message: string | null;
  readonly file: string | null;
  readonly line: number | null;
}

/** `app_start`: every launch, after the children are up. */
export function appStart(facts: {
  readonly startupMs: number;
  readonly packages: readonly ReportedPackage[];
  readonly unsignedPackages: number;
  readonly firstLaunch: boolean;
}): Signal {
  return {
    name: "app_start",
    fields: {
      startup_ms: whole(facts.startupMs),
      packages: facts.packages.map((entry) => ({ id: entry.id, version: entry.version })),
      unsigned_packages: facts.unsignedPackages,
      first_launch: facts.firstLaunch,
    },
  };
}

export type StopReason = "quit" | "update" | "restart";

/** `app_stop`: every quit, queued before the children stop. */
export function appStop(uptimeS: number, reason: StopReason): Signal {
  return { name: "app_stop", fields: { uptime_s: whole(uptimeS), reason } };
}

/** `app_unclean_stop`: at start, when the last launch left no `app_stop`. */
export function appUncleanStop(lastVersion: string): Signal {
  return { name: "app_unclean_stop", fields: { last_version: lastVersion } };
}

function stepFields(facts: PackageFacts, step: StepFacts): Record<string, unknown> {
  return {
    ...packageFields(facts),
    node_kind: step.nodeKind,
    // A type id is its author's words too: an unsigned package's is not named either.
    node_id: facts.signed ? step.nodeId : null,
    duration_ms: whole(step.durationMs),
    ok: step.ok,
  };
}

/** `package_used`: every time a node of a package runs one step. */
export function packageUsed(facts: PackageFacts, step: StepFacts): Signal {
  return { name: "package_used", fields: stepFields(facts, step) };
}

/**
 * `package_error`: every time such a step fails: the type of the error, its message (redacted
 * and scrubbed by the pipeline), and where it was thrown. An unsigned package's file is its
 * author's path: only the line is sent.
 */
export function packageError(facts: PackageFacts, step: StepFacts, failure: StepFailure): Signal {
  return {
    name: "package_error",
    fields: {
      ...stepFields(facts, { ...step, ok: false }),
      error_type: errorTypeOf(failure.errorType),
      error: failure.message,
      file: facts.signed ? stepFile(failure.file) : null,
      line: lineOf(failure.line),
    },
  };
}

/** One tools/call on the loopback endpoint, as the services process saw it. */
export interface McpCallFacts {
  /** The tool's name, only when the validated set holds it. */
  readonly tool: string | null;
  readonly client: string | null;
  readonly durationMs: number;
  readonly ok: boolean;
  /** The JSON-RPC error's code; null for a result. */
  readonly errorCode: number | null;
}

/** The package that answers the loopback MCP endpoint. */
export const MCP_PACKAGE = "reload_anytype";

/** `mcp_call`: every tools/call on the loopback endpoint. */
export function mcpCall(version: string | null, call: McpCallFacts): Signal {
  return {
    name: "mcp_call",
    fields: {
      package: MCP_PACKAGE,
      version,
      // Lowercased: a long capitalised name (`API-get-collection-views`) would read as a key to
      // the scrub, which every string passes, this one too.
      tool: call.tool?.toLowerCase() ?? null,
      client: clientOf(call.client),
      duration_ms: whole(call.durationMs),
      ok: call.ok,
      error_code: call.errorCode,
    },
  };
}

/** How many nodes one package has in the deployed flows. */
export interface PackageCount {
  readonly package: string;
  readonly nodes: number;
}

/**
 * `flow_deployed`: every deploy, with exact counts (the owner makes the buckets). The packages
 * are listed as `{package, nodes}` pairs, never as keys: a key made of a name would be a field
 * name nobody chose.
 */
export function flowDeployed(
  nodesPerFlow: readonly number[],
  perPackage: readonly PackageCount[],
): Signal {
  return {
    name: "flow_deployed",
    fields: {
      flows: nodesPerFlow.length,
      nodes: nodesPerFlow.reduce((sum, count) => sum + count, 0),
      nodes_per_flow: [...nodesPerFlow],
      nodes_per_package: perPackage.map((entry) => ({
        package: entry.package,
        nodes: entry.nodes,
      })),
    },
  };
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

/** A URL's host, or `file` for a local source (rule 3); null when there is none. */
function providerHost(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  return url.toLowerCase().startsWith("file:") ? "file" : hostOnly(url);
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
      provider_host: providerHost(provider.url),
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

/** `provider_removed`: a provider is removed. */
export function providerRemoved(provider: ProviderFacts): Signal {
  return {
    name: "provider_removed",
    fields: { provider_host: providerHost(provider.url), official: provider.official },
  };
}

/** Where an install came from: a catalogue's address, or a file on this machine (never named). */
export type InstallOrigin =
  { readonly kind: "catalogue"; readonly url: string | null } | { readonly kind: "file" };

function installFields(
  facts: PackageFacts,
  origin: InstallOrigin,
  nodeTypes: number,
): Record<string, unknown> {
  return {
    ...packageFields(facts),
    provider_host: origin.kind === "file" ? "file" : providerHost(origin.url),
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
      from_version: facts.signed ? fromVersion : null,
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
      provider_host: origin.kind === "file" ? "file" : providerHost(origin.url),
      reason: /^[a-z][a-z0-9-]{0,39}$/.test(reason) ? reason : "other",
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
    fields: { from_version: fromVersion, to_version: toVersion, channel },
  };
}

/**
 * What the runtime and the services process tell the shell about a signal (the `signal` channel
 * message): the facts only. The shell names the package and builds the event.
 */
export type ChildSignal =
  | {
      readonly kind: "step";
      readonly package: string;
      readonly step: StepFacts;
      readonly failure: StepFailure | null;
    }
  | { readonly kind: "mcp-call"; readonly call: McpCallFacts }
  | {
      readonly kind: "deployed";
      readonly nodesPerFlow: readonly number[];
      readonly perPackage: readonly PackageCount[];
    };

// ── retention ────────────────────────────────────────────────────────────────────────────

/**
 * How long usage counts are kept, named so the notice and any server configuration read the same:
 * Umami Cloud's Hobby plan keeps them 6 months (owner, 2026-10-15).
 */
export const USAGE_RETENTION_MONTHS = 6;
