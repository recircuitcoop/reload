// The check every queued report passes just before it is sent (plan 0029): the queue is a folder
// any process of this account can write to, so what it holds is read as untrusted and held to
// the rules again, whatever the builders did when it was made.
//
// * A report stamped under other rules, or naming no known event, is dropped unsent.
// * Only the event's own fields leave: any other key is dropped, `crashes` keeps its four counts.
// * Each field's value is held to its rule: text to its vocabulary or shape, a number to a whole
//   number in a stated range, a flag to a boolean. What does not fit leaves as "[withheld]".
// * The fields whose value is vouched for by where it came from (package, node_id, file, line,
//   provider_host) are asked again of the package store and the build's catalogue, and fall back
//   to `unsigned`, "[withheld]" or `custom`.
// * The field-name rule runs again over the whole report, and the scrub over what is left.

import { credentialFieldName, scrubPayload, WITHHELD, type Json, type JsonObject } from "./redact";
import { isSignalName, type SignalName } from "./reports";
import {
  ARCHES,
  CHANNELS,
  CLIENT_LABELS,
  errorCodeOf,
  ERROR_TYPES,
  HOST,
  IDENTIFIER,
  INSTALL_REFUSALS,
  OS_NAMES,
  OTHER,
  RULES_VERSION,
  SOURCE_FILE,
  VERSION,
} from "./vocabulary";

/** What the app vouches for at send: the package store's and the build's own answers. */
export interface Vouch {
  /**
   * A package shipped with the app or signed by the build's own catalogue's key, as the store
   * lists it now or listed it when a report about it was queued.
   */
  readonly package: (name: string) => boolean;
  /** A type id the signed package `pkg` declares. */
  readonly nodeType: (pkg: string, id: string) => boolean;
  /** The line count of `file` in signed package `pkg` (0 when unknown); null when not held. */
  readonly lines: (pkg: string, file: string) => number | null;
  /** The build's own catalogue's host. */
  readonly host: (host: string) => boolean;
  /** A tool the served Anytype MCP child lists (the committed surface), lowercased. */
  readonly tool: (name: string) => boolean;
}

/** What a package the build's catalogue vouched for keeps vouched until its reports are sent. */
export interface VouchedPackage {
  readonly nodeTypes: readonly string[];
  readonly held: Readonly<Record<string, number>>;
}

/** The pipeline's own stamps, which no builder makes and the scrub would take for keys. */
export const OWN_IDENTIFIERS: readonly string[] = ["machine_id", "report_id"];

type Rule =
  | { readonly kind: "text"; readonly fits: (value: string) => boolean }
  | { readonly kind: "int"; readonly min: number; readonly max: number }
  | { readonly kind: "code" }
  | { readonly kind: "flag" };

const text = (fits: (value: string) => boolean): Rule => ({ kind: "text", fits });
const int = (min: number, max: number): Rule => ({ kind: "int", min, max });
const FLAG: Rule = { kind: "flag" };
const oneOf = (...values: readonly string[]) => text((value) => values.includes(value));
const inSet = (names: ReadonlySet<string>) => text((value) => names.has(value) || value === OTHER);
const shape = (pattern: RegExp) => text((value) => pattern.test(value));

/** A count of things (nodes, packages, flows): whole, from 0 to a million. */
const COUNT = int(0, 1_000_000);
/** A duration in milliseconds or seconds: whole, from 0 to a billion (eleven days in ms). */
const DURATION = int(0, 1_000_000_000);

/** Every field any report may carry, and its rule. */
const RULES: Readonly<Record<string, Rule>> = {
  event: text(isSignalName),
  kind: oneOf("usage", "error"),
  machine_id: shape(/^[0-9a-f]{64}$/),
  report_id: shape(/^[0-9a-f]{32}$/),
  at: shape(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  rules: int(RULES_VERSION, RULES_VERSION),
  app_version: shape(VERSION),
  os: inSet(OS_NAMES),
  os_version: shape(VERSION),
  arch: inSet(ARCHES),
  startup_ms: DURATION,
  packages: COUNT,
  unsigned_packages: COUNT,
  first_launch: FLAG,
  uptime_s: DURATION,
  reason: text((value) => ["quit", "update", OTHER].includes(value) || INSTALL_REFUSALS.has(value)),
  last_version: shape(VERSION),
  package: shape(IDENTIFIER),
  version: shape(VERSION),
  source: oneOf("shipped", "catalogue", "file"),
  signed: FLAG,
  environment: oneOf("uv-python", "node", "executable"),
  node_kind: oneOf("source", "node", "view"),
  node_id: shape(IDENTIFIER),
  duration_ms: DURATION,
  ok: FLAG,
  error_type: inSet(ERROR_TYPES),
  file: shape(SOURCE_FILE),
  line: int(1, 10_000_000),
  method: oneOf("tools/call", "resources/read"),
  tool: shape(IDENTIFIER),
  client: inSet(CLIENT_LABELS),
  error_code: { kind: "code" },
  flows: COUNT,
  total_nodes: COUNT,
  nodes: COUNT,
  config_nodes: COUNT,
  step: oneOf("launched", "anytype_paired", "first_flow_deployed"),
  provider_host: shape(HOST),
  official: FLAG,
  signer_fingerprint: shape(/^[0-9a-f]{1,12}$/),
  packages_offered: COUNT,
  node_types: COUNT,
  from_version: shape(VERSION),
  to_version: shape(VERSION),
  channel: inSet(CHANNELS),
  exception_type: oneOf("RuntimeCrashed", "ServicesCrashed", "NodeProcessCrashed"),
  crashed: oneOf("runtime", "services", "node"),
  stopped_for_good: FLAG,
};

/** The fields every report carries: the pipeline's stamps and the version fields. */
const COMMON = ["kind", "machine_id", "report_id", "at", "rules", "app_version", "os"];
const COMMON_REST = ["os_version", "arch"];
const PACKAGE = ["package", "version", "source", "signed", "environment"];
const STEP = [...PACKAGE, "node_kind", "node_id", "duration_ms", "ok"];
const INSTALL = [...PACKAGE, "provider_host", "node_types"];

/** Each event's own fields, beside the common ones. */
const EVENT_FIELDS: Readonly<Record<SignalName, readonly string[]>> = {
  app_start: ["startup_ms", "packages", "unsigned_packages", "first_launch"],
  app_stop: ["uptime_s", "reason"],
  app_unclean_stop: ["last_version"],
  package_used: STEP,
  package_error: [...STEP, "error_type", "file", "line"],
  mcp_call: ["package", "version", "method", "tool", "client", "duration_ms", "ok", "error_code"],
  flow_deployed: ["flows", "total_nodes", "nodes", "config_nodes"],
  package_deployed: ["package", "nodes"],
  package_present: PACKAGE,
  setup_step: ["step"],
  provider_registered: ["provider_host", "official", "signer_fingerprint", "packages_offered"],
  provider_removed: ["provider_host", "official"],
  package_installed: INSTALL,
  package_updated: [...INSTALL, "from_version"],
  package_removed: ["package", "version", "source", "signed"],
  package_install_failed: ["source", "provider_host", "reason"],
  update_offered: ["from_version", "to_version", "channel"],
  update_applied: ["from_version", "to_version", "channel"],
};

/** A crash report's own fields. */
const CRASH_FIELDS = ["exception_type", "crashed", "stopped_for_good", "crashes"];
const CRASH_COUNTS = ["runtime", "services", "node", "node_stopped"];

/** Package names that are no package's own: Node-RED's nodes, and what is never named. */
const NAMED_NOWHERE = ["unsigned", "custom", "node-red"];

/** One value by its rule: what does not fit is WITHHELD; null stays null. */
function held(rule: Rule, value: Json | undefined): Json {
  if (value === null || value === undefined || value === WITHHELD) {
    return value ?? null;
  }
  switch (rule.kind) {
    case "flag":
      return typeof value === "boolean" ? value : WITHHELD;
    case "int":
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= rule.min &&
        value <= rule.max
        ? value
        : WITHHELD;
    case "code":
      return errorCodeOf(value);
    case "text":
      return typeof value === "string" && rule.fits(value) ? value : WITHHELD;
  }
}

/** The crash counts: the four of them, each a count. */
function crashCounts(value: Json | undefined): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return WITHHELD;
  }
  return Object.fromEntries(CRASH_COUNTS.map((name) => [name, held(COUNT, value[name])]));
}

/**
 * The vouched-for fields asked of the package store, the build's catalogue and the served tools:
 * what they do not vouch for falls back. A package the build's own catalogue did not sign keeps
 * no name, version, type or file: `custom` when another catalogue signed it, `unsigned` when
 * nobody did. Applied when a report is queued and again when it is sent.
 */
export function vouchedFields<T extends Readonly<Record<string, unknown>>>(
  report: T,
  vouch: Vouch,
): T {
  const checked: Record<string, unknown> = { ...report };
  const pkg = checked["package"];
  if (typeof pkg === "string" && !NAMED_NOWHERE.includes(pkg) && !vouch.package(pkg)) {
    checked["package"] = checked["signed"] === true ? "custom" : "unsigned";
    for (const field of ["version", "from_version"]) {
      if (typeof checked[field] === "string") {
        checked[field] = null;
      }
    }
  }
  const owner = typeof checked["package"] === "string" ? checked["package"] : null;
  const named = owner !== null && !NAMED_NOWHERE.includes(owner) ? owner : null;
  const id = checked["node_id"];
  if (typeof id === "string" && !NAMED_NOWHERE.includes(id)) {
    if (named === null) {
      checked["node_id"] = owner === "custom" ? "custom" : null;
    } else if (!vouch.nodeType(named, id)) {
      checked["node_id"] = "unsigned";
    }
  }
  const file = checked["file"];
  const lines = typeof file === "string" && named !== null ? vouch.lines(named, file) : null;
  if (typeof file === "string" && lines === null) {
    checked["file"] = WITHHELD;
  }
  const line = checked["line"];
  if (typeof line === "number" && (lines === null || lines === 0 || line > lines)) {
    checked["line"] = WITHHELD;
  }
  const tool = checked["tool"];
  if (typeof tool === "string" && !vouch.tool(tool)) {
    checked["tool"] = WITHHELD;
  }
  const host = checked["provider_host"];
  if (typeof host === "string" && host !== "custom" && host !== "file" && !vouch.host(host)) {
    checked["provider_host"] = "custom";
  }
  return checked as T;
}

/**
 * A queued report's payload as it may leave, or null when it may not leave at all: stamped under
 * other rules, naming no known event, carrying a field named like a credential, or not stamped
 * by this pipeline with `machineId` (this machine's) and a report id of its own.
 */
export function checkAtSend(
  payload: JsonObject,
  kind: "usage" | "error",
  vouch: Vouch,
  machineId: string | null,
): JsonObject | null {
  // A report under other rules, or one carrying a field named like a credential, was not made
  // by this app as it is: it does not leave at all.
  if (payload["rules"] !== RULES_VERSION || credentialFieldName(payload) !== null) {
    return null;
  }
  // The pipeline's own stamps, or not its report: this machine's id, and a random id of its own.
  const id = payload["report_id"];
  if (
    machineId === null ||
    !/^[0-9a-f]{64}$/.test(machineId) ||
    payload["machine_id"] !== machineId ||
    typeof id !== "string" ||
    !/^[0-9a-f]{32}$/.test(id)
  ) {
    return null;
  }
  const event = payload["event"];
  let own: readonly string[];
  if (kind === "error") {
    own = CRASH_FIELDS;
  } else if (isSignalName(event)) {
    own = ["event", ...EVENT_FIELDS[event]];
  } else {
    return null;
  }
  const allowed = new Set([...COMMON, ...COMMON_REST, ...own]);
  const report: JsonObject = {};
  // In the order the report was made: any key not on the event's own list does not leave.
  for (const name of Object.keys(payload)) {
    if (!allowed.has(name)) {
      continue;
    }
    const value = payload[name];
    const rule = RULES[name];
    report[name] =
      name === "crashes" ? crashCounts(value) : rule === undefined ? WITHHELD : held(rule, value);
  }
  return scrubPayload(vouchedFields(report, vouch), OWN_IDENTIFIERS);
}
