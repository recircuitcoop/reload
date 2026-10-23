// The node package declaration, `reload-package.json` (spec §2), as the runtime holds it once
// it has been parsed and refused or accepted (plan 0018 §3, the addons/manifest.py row).
//
// Like the old manifest it refuses and never warns: a declaration that breaks any rule is not
// loaded, and every refusal names the field it is about. The shape is judged by the spec's
// own §2.6 JSON Schema, which the caller checks with a real validator (ajv, in
// adapters/schema) and hands in as `check`; this file adds what a schema cannot say.
//
// Pure: no I/O, no library.

import type { DeclaredLimits } from "../supervision/resources";
import type { StabilityProfile } from "../supervision/staleness";
import { configProblems, type ConfigJudge } from "./config-lint";
import { oldKeywordAt, oldKeywordProblem } from "./old-names";
import { compareVersions } from "./versions";

/** The one protocol version this runtime implements (spec 1.2). */
export const PROTOCOL = 2;

/** Spec 2.4: output ports that would shadow a Node-RED message field. */
const RESERVED_PORTS: readonly string[] = ["_msgid", "topic"];

/** The owner reserved for created event types (spec 5.2.1, 5.2.3). */
const USER_OWNER = "user";

export type Kind = "source" | "node" | "view";

/** A JSON Schema object, as declared (spec 2.4 `config`, `payload`, `form`, `answer`, `props`). */
export type JsonSchema = Readonly<Record<string, unknown>>;

export type DeclaredCommand =
  | readonly string[]
  | {
      readonly darwin?: readonly string[];
      readonly win32?: readonly string[];
      readonly linux?: readonly string[];
      readonly default?: readonly string[];
    };

export interface DeclaredOutput {
  readonly port: string;
  readonly event: string;
}

export interface DeclaredAction {
  readonly id: string;
  readonly label: string;
  readonly event: string;
  readonly form?: JsonSchema;
}

export interface DeclaredType {
  readonly id: string;
  readonly kind: Kind;
  readonly view?: "action" | "snapshot";
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly command: DeclaredCommand;
  readonly config: JsonSchema;
  readonly outputs: readonly DeclaredOutput[];
  readonly actions?: readonly DeclaredAction[];
  readonly input?: boolean;
  readonly event?: string;
  readonly payload?: JsonSchema;
  /** A view's answer schema (spec 2.4); without one, the default shape of spec 8.5.7. */
  readonly answer?: JsonSchema;
  /** An action view's props schema (spec 2.4); without one, its props get the bounds only. */
  readonly props?: JsonSchema;
  /** How Reload supervises the type's processes (spec 2.4.2). */
  readonly reload?: TypeSupervision;
}

/** A type's `reload` object (spec 2.4.2). */
export interface TypeSupervision {
  /** The type promises to answer `ping`; without it, a process is never judged stuck. */
  readonly heartbeat?: { readonly interval_s: number; readonly stale_after_s?: number };
  /** False: a process that exits unexpectedly is never started again. Absent means true. */
  readonly restartable?: boolean;
  /** Its own resource limits, over the defaults. */
  readonly limits?: DeclaredLimits;
}

/** An executable package's binary for one platform: its path in the package, and its sha256. */
export interface DeclaredBinary {
  readonly path: string;
  readonly sha256: string;
}

export interface Declaration {
  readonly protocol: 2;
  readonly package: string;
  readonly version: string;
  readonly environment?: {
    readonly kind: "uv-python" | "node" | "executable";
    readonly python?: string;
    readonly node?: string;
    /** `executable` only: one binary per `<platform>-<arch>`, with its sha256 (spec 2.3.3). */
    readonly binaries?: Readonly<Record<string, DeclaredBinary>>;
  };
  readonly types: readonly DeclaredType[];
}

/** A type of a loaded package, and the folder its package is in (spec 2.3.4). */
export interface LoadedType {
  readonly declaration: Declaration;
  readonly type: DeclaredType;
  readonly folder: string;
}

/** One problem a schema validator found: the JSON Pointer of the field, and what is wrong. */
export interface FieldProblem {
  readonly path: string;
  readonly message: string;
}

export type ParsedDeclaration =
  | { readonly ok: true; readonly declaration: Declaration }
  | { readonly ok: false; readonly problems: readonly string[] };

/** One output port of a type, in port order (spec 2.2). */
export interface Port {
  readonly port: string;
  readonly event: string;
  /** The label the editor shows beside the port. */
  readonly label: string;
  /** A snapshot view's action port, which comes after every pass-through port. */
  readonly action: boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A problem as a person reads it: the field, then what is wrong with it. */
function said(problem: FieldProblem): string {
  const field = problem.path === "" ? "the declaration" : problem.path.slice(1);
  return `${field}: ${problem.message}`;
}

/** Freeze a parsed value all the way down, so no holder can change what was judged. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

const isSecretProperty = (property: Readonly<Record<string, unknown>>): boolean =>
  property["writeOnly"] === true || property["x-secret"] === true;

/** Whether `value`, by `schema`, holds a value for a secret at any depth. */
function holdsSecret(schema: Readonly<Record<string, unknown>>, value: unknown): boolean {
  if (isSecretProperty(schema)) {
    return value !== undefined && value !== "";
  }
  const items = schema["items"];
  if (Array.isArray(value)) {
    return isRecord(items) && value.some((each: unknown) => holdsSecret(items, each));
  }
  const properties = schema["properties"];
  if (!isRecord(value) || !isRecord(properties)) {
    return false;
  }
  return Object.entries(properties).some(
    ([key, property]) => key in value && isRecord(property) && holdsSecret(property, value[key]),
  );
}

/**
 * The config's defaults that hold a value for a secret, by the path of the property whose
 * default it is ("account"): a default is written into the plain flows, so a package author's
 * secret would land there (a secret's own default is never written: it is a credential).
 */
function secretDefaults(schema: Readonly<Record<string, unknown>>, path = ""): string[] {
  const properties = schema["properties"];
  const own = isRecord(properties) ? Object.entries(properties) : [];
  return own.flatMap(([key, property]) => {
    if (!isRecord(property)) {
      return [];
    }
    const name = path === "" ? key : `${path}.${key}`;
    const here =
      !isSecretProperty(property) &&
      "default" in property &&
      holdsSecret(property, property["default"])
        ? [name]
        : [];
    const items = property["items"];
    return [
      ...here,
      ...secretDefaults(property, name),
      ...(isRecord(items) ? secretDefaults(items, name) : []),
    ];
  });
}

/** Keywords whose subschemas the form never draws as fields of their own. */
const UNDRAWN = [
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "unevaluatedItems",
  "additionalItems",
  "contentSchema",
];
/** Keywords holding a map of subschemas the form never draws as fields of their own. */
const UNDRAWN_MAPS = [
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
];

/**
 * The schema pointers of every secret the forms cannot keep or refuse by its shape: one reached
 * other than through `properties` of a `type: "object"` and `items` of a `type: "array"` (an
 * `anyOf` branch, a `$defs` entry a `$ref` names, `additionalProperties`, an array typed
 * `["array", "null"]` or not typed at all…). A group's, a list's and a table row's secrets are
 * the shapes the forms know (form-model.ts, unkept.ts).
 */
function unsupportedSecrets(schema: unknown, path = "", supported = true): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((each, index) =>
      unsupportedSecrets(each, `${path}/${String(index)}`, false),
    );
  }
  if (!isRecord(schema)) {
    return [];
  }
  const here = isSecretProperty(schema) && !supported ? [path === "" ? "/" : path] : [];
  const type = schema["type"];
  const properties = schema["properties"];
  const items = schema["items"];
  const map = (value: unknown, at: string, keep: boolean): string[] =>
    isRecord(value)
      ? Object.entries(value).flatMap(([key, inner]) =>
          unsupportedSecrets(inner, `${at}/${key}`, keep),
        )
      : [];
  return [
    ...here,
    ...map(properties, `${path}/properties`, supported && (path === "" || type === "object")),
    ...unsupportedSecrets(items, `${path}/items`, supported && type === "array"),
    ...UNDRAWN.flatMap((keyword) =>
      unsupportedSecrets(schema[keyword], `${path}/${keyword}`, false),
    ),
    ...UNDRAWN_MAPS.flatMap((keyword) => map(schema[keyword], `${path}/${keyword}`, false)),
    ...unsupportedSecrets(schema["prefixItems"], `${path}/prefixItems`, false),
  ];
}

/**
 * The schema pointers of every `$ref` the form's compiler cannot resolve: the form compiles the
 * config with its secrets taken out, so a reference may only name the config itself ("#") or an
 * entry of its `$defs` or `definitions` that exists; one into `properties`, outside the config,
 * missing, or a `$dynamicRef`/`$recursiveRef` would leave the form without its schema.
 */
function unresolvableRefs(root: unknown, schema: unknown = root, path = ""): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((each, index) =>
      unresolvableRefs(root, each, `${path}/${String(index)}`),
    );
  }
  if (!isRecord(schema)) {
    return [];
  }
  const here: string[] = [];
  const ref = schema["$ref"];
  if (typeof ref === "string" && !resolvesInDefs(root, ref)) {
    here.push(`${path}/$ref`);
  }
  for (const dynamic of ["$dynamicRef", "$recursiveRef"]) {
    if (dynamic in schema) {
      here.push(`${path}/${dynamic}`);
    }
  }
  return [
    ...here,
    ...Object.entries(schema).flatMap(([key, inner]) =>
      // A `const`, `enum`, `default` or `examples` holds values, not schemas.
      ["const", "enum", "default", "examples"].includes(key)
        ? []
        : unresolvableRefs(root, inner, `${path}/${key}`),
    ),
  ];
}

/** Whether `ref` is "#" or names an existing entry of the root's `$defs` or `definitions`. */
function resolvesInDefs(root: unknown, ref: string): boolean {
  if (ref === "#") {
    return true;
  }
  const found = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (found === null || !isRecord(root)) {
    return false;
  }
  const defs = root[found[1] as string];
  const name = (found[2] as string).replaceAll("~1", "/").replaceAll("~0", "~");
  return isRecord(defs) && isRecord(defs[name]);
}

/**
 * The config's property names that hold a dot, by their path ("account.a.b"): a secret's
 * credential is named by its path through the groups ("account.token"), so a dotted name would
 * share one credential with a group's property and be judged in the wrong place.
 */
function dottedNames(schema: Readonly<Record<string, unknown>>, path = ""): string[] {
  const properties = schema["properties"];
  const own = isRecord(properties) ? Object.entries(properties) : [];
  return own.flatMap(([key, property]) => {
    const name = path === "" ? key : `${path}.${key}`;
    const here = key.includes(".") ? [name] : [];
    if (!isRecord(property)) {
      return here;
    }
    const items = property["items"];
    return [
      ...here,
      ...dottedNames(property, name),
      ...(isRecord(items) ? dottedNames(items, name) : []),
    ];
  });
}

/** The rules a JSON Schema cannot state: uniqueness, reserved ports, event owners. */
function beyondTheSchema(declaration: Declaration): string[] {
  const problems: string[] = [];
  // One exact version, so a check can order it: never a range, a tag or nothing (manifest.py).
  if (compareVersions(declaration.version, declaration.version) === null) {
    problems.push(
      `version: ${JSON.stringify(declaration.version)} is not an exact version; a package ` +
        "declares the one version it is, as numbers joined by dots (1.4.0, or 2.0.0-rc.1)",
    );
  }
  const typeIds = new Set<string>();
  declaration.types.forEach((type, index) => {
    const at = `types/${String(index)}`;
    for (const dotted of dottedNames(type.config)) {
      problems.push(
        `${at}/config: ${JSON.stringify(dotted)} holds a dot, which a property name may not: ` +
          "a secret is named by its path through the groups",
      );
    }
    for (const ref of unresolvableRefs(type.config)) {
      problems.push(
        `${at}/config${ref}: the form cannot resolve this reference; ` +
          "name an entry of the config's own $defs instead",
      );
    }
    for (const secret of unsupportedSecrets(type.config)) {
      problems.push(
        `${at}/config${secret === "/" ? "" : secret}: a secret in this place cannot be kept ` +
          "nor refused by the form; declare it as a property, in a group, a list or a table's row",
      );
    }
    for (const secret of secretDefaults(type.config)) {
      problems.push(
        `${at}/config: the default of ${JSON.stringify(secret)} holds a secret's value, which ` +
          "would be written into the plain flows; leave the secret out of the default",
      );
    }
    if (typeIds.has(type.id)) {
      problems.push(`${at}/id: ${JSON.stringify(type.id)} is declared twice in this package`);
    }
    typeIds.add(type.id);
    const beat = type.reload?.heartbeat;
    if (beat?.stale_after_s !== undefined && beat.stale_after_s < beat.interval_s) {
      problems.push(
        `${at}/reload/heartbeat/stale_after_s: ${String(beat.stale_after_s)} s is shorter than ` +
          `interval_s (${String(beat.interval_s)} s); a process must have at least one interval ` +
          "to answer before it is judged stuck",
      );
    }
    const ports = new Set<string>();
    const named: { port: string; event: string; field: string }[] = [
      ...type.outputs.map((o, i) => ({ ...o, field: `${at}/outputs/${String(i)}` })),
      ...(type.actions ?? []).map((a, i) => ({
        port: a.id,
        event: a.event,
        field: `${at}/actions/${String(i)}`,
      })),
    ];
    for (const { port, event, field } of named) {
      const portField = field.includes("/actions/") ? `${field}/id` : `${field}/port`;
      if (RESERVED_PORTS.includes(port)) {
        problems.push(`${portField}: ${JSON.stringify(port)} is a Node-RED message field`);
      }
      if (ports.has(port)) {
        problems.push(`${portField}: port ${JSON.stringify(port)} is declared twice`);
      }
      ports.add(port);
      // Spec 5.2.3: a package emits under its own name only, and never `user.*`.
      const owner = event.slice(0, event.indexOf("."));
      if (owner !== declaration.package) {
        problems.push(
          `${field}/event: ${JSON.stringify(event)} is owned by ${JSON.stringify(owner)}` +
            (owner === USER_OWNER ? ", which is reserved for created event types" : "") +
            `; package ${declaration.package} may emit only ${declaration.package}.*`,
        );
      }
    }
  });
  return problems;
}

/** The validator a declaration is judged with: the spec 2.6 schema, and each type's config. */
export interface DeclarationJudge extends ConfigJudge {
  /** What is wrong with a declaration by the spec's §2.6 schema; empty when nothing is. */
  declaration(value: unknown): readonly FieldProblem[];
}

/**
 * Parse a declaration (any JSON value). The protocol is judged first, so a package written for
 * another version is refused naming both versions (spec 1.3) rather than with a schema error.
 * Then the spec 2.6 schema (through a real validator), then the rules beyond it, then each
 * type's config as the form draws it (config-lint.ts).
 */
export function parseDeclaration(value: unknown, judge: DeclarationJudge): ParsedDeclaration {
  if (!isRecord(value)) {
    return { ok: false, problems: ["the declaration: must be a JSON object"] };
  }
  if ("protocol" in value && value["protocol"] !== PROTOCOL) {
    return {
      ok: false,
      problems: [
        `protocol: ${JSON.stringify(value["protocol"])} is not implemented by this runtime, ` +
          `which implements protocol ${String(PROTOCOL)}`,
      ],
    };
  }
  // A package still written for the old contract is refused naming the new keyword (plan 0028 D3).
  const oldKeyword = oldKeywordAt(value);
  if (oldKeyword !== null) {
    return { ok: false, problems: [oldKeywordProblem(oldKeyword, "reload")] };
  }
  const schemaProblems = judge.declaration(value);
  if (schemaProblems.length > 0) {
    return { ok: false, problems: schemaProblems.map(said) };
  }
  // The schema has judged the shape: from here on the value is a Declaration.
  const declaration = structuredClone(value) as unknown as Declaration;
  const problems = beyondTheSchema(declaration);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const configs = declaration.types.flatMap((type, index) =>
    configProblems(type.config, `/types/${String(index)}/config`, judge).map(said),
  );
  if (configs.length > 0) {
    return { ok: false, problems: configs };
  }
  return { ok: true, declaration: deepFreeze(declaration) };
}

/** A type's declared heartbeat as the runtime judges it (spec 2.4.2); null when it has none. */
export function stabilityOf(type: DeclaredType): StabilityProfile | null {
  const heartbeat = type.reload?.heartbeat;
  if (heartbeat === undefined) {
    return null;
  }
  return {
    heartbeatIntervalMs: heartbeat.interval_s * 1000,
    staleAfterMs: heartbeat.stale_after_s === undefined ? null : heartbeat.stale_after_s * 1000,
  };
}

/** The Node-RED type name, derived and never declared (spec 2.1.4). */
export function nodeTypeName(packageName: string, typeId: string): string {
  return `reload-${packageName}-${typeId}`;
}

/**
 * Every output port of a type, in the order the runtime maps them (spec 2.2): the declared
 * `outputs` (pass-through), then, for a snapshot view, one port per action.
 */
export function portsOf(type: DeclaredType): Port[] {
  const passThrough = type.outputs.map((output) => ({
    port: output.port,
    event: output.event,
    label: `${output.port} (${output.event})`,
    action: false,
  }));
  const actions = (type.actions ?? []).map((action) => ({
    port: action.id,
    event: action.event,
    label: `action: ${action.label}`,
    action: true,
  }));
  return [...passThrough, ...actions];
}

/** How many inputs a type has (spec 2.2): a source none, unless it declares `input: true`. */
export function inputsOf(type: DeclaredType): 0 | 1 {
  return type.kind === "source" && type.input !== true ? 0 : 1;
}
