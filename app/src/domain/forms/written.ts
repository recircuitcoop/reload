// A node writes its own settings (spec 2.4.1 `reload.writtenBy`, 4.6; revision 2.2, plan 0032
// WI-0032-41), as the old settings store let a plugin record a value it found while running (an
// OAuth token it obtained) and said who set it, and when (tests/test_settings_store.py,
// test_addon_settings_runtime.py, test_plugin_secrets.py).
//
// This judges a write, keeps the record of who wrote what, and merges what a node wrote over
// what the person deployed. Where the record is kept is the WrittenStore port's.
//
// Pure: no I/O, no library.

import type { FieldProblem, JsonSchema } from "../packages/declaration";
import { isSecret, propertiesOf, rowSchemaOf } from "./form-model";
import { writtenBy } from "./reload-keyword";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Who wrote one property, and when (ISO 8601): a package's name, or "user" for the person. */
export interface WrittenBy {
  readonly by: string;
  readonly at: string;
}

/** The person, as the record names them. */
export const USER = "user";

/**
 * What a node wrote of one instance's settings: each value, its secrets apart, and who wrote
 * each property and when; one record per property, however many rows a table holds.
 */
export interface WrittenRecord {
  readonly values: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly written: Readonly<Record<string, WrittenBy>>;
}

export const NO_RECORD: WrittenRecord = { values: {}, secrets: {}, written: {} };

/** The outcome of a write: what was recorded, and what was refused, each by its pointer. */
export interface WriteOutcome {
  readonly recorded: readonly string[];
  readonly refused: readonly FieldProblem[];
}

/** The keys of a row its schema does not declare and does not let in, by their pointers. */
function undeclaredRowKeys(schema: JsonSchema, value: unknown, path: string): FieldProblem[] {
  const row = rowSchemaOf(schema);
  if (row === null || !Array.isArray(value)) {
    return [];
  }
  const declared = new Map(propertiesOf(row));
  const open = row["additionalProperties"] !== undefined && row["additionalProperties"] !== false;
  return value.flatMap((each: unknown, index) => {
    if (!isRecord(each)) {
      return [];
    }
    const at = `${path}/${String(index)}`;
    return Object.entries(each).flatMap(([key, inner]) => {
      const column = declared.get(key);
      if (column !== undefined) {
        return undeclaredRowKeys(column, inner, `${at}/${key}`);
      }
      return open
        ? []
        : [{ path: at, message: `holds ${JSON.stringify(key)}, which its row does not declare` }];
    });
  });
}

/**
 * Judge `values`, a node of package `own` writing its settings, against `schema` (its config):
 * a write in another package's name is refused whole; then each value on its own, recorded
 * when its top-level property lets the node set it and its value passes its own schema.
 */
export function judgeWrite(
  schema: JsonSchema,
  values: Readonly<Record<string, unknown>>,
  own: string,
  by: unknown,
  check: (schema: JsonSchema, value: unknown) => readonly FieldProblem[],
): { readonly accepted: Readonly<Record<string, unknown>>; readonly outcome: WriteOutcome } {
  if (by !== undefined && by !== own) {
    const message =
      `is a write in the name of ${JSON.stringify(by)}: package ${own} writes only its own ` +
      "settings";
    return { accepted: {}, outcome: { recorded: [], refused: [{ path: "", message }] } };
  }
  const declared = new Map(propertiesOf(schema));
  const accepted: Record<string, unknown> = {};
  const refused: FieldProblem[] = [];
  for (const [key, value] of Object.entries(values)) {
    const at = `/${key}`;
    const property = declared.get(key);
    if (property === undefined) {
      refused.push({ path: at, message: "is not a declared property" });
      continue;
    }
    if (writtenBy(property) === null) {
      refused.push({ path: at, message: "is left to the person: its package may not set it" });
      continue;
    }
    const problems = [
      ...check(property, value).map((problem) => ({ ...problem, path: `${at}${problem.path}` })),
      ...undeclaredRowKeys(property, value, at),
    ];
    if (problems.length > 0) {
      refused.push(...problems);
    } else {
      accepted[key] = value;
    }
  }
  return { accepted, outcome: { recorded: Object.keys(accepted), refused } };
}

/** `record` with `accepted` written into it by package `by` at `at`, secrets kept apart. */
export function recorded(
  record: WrittenRecord,
  schema: JsonSchema,
  accepted: Readonly<Record<string, unknown>>,
  by: string,
  at: string,
): WrittenRecord {
  const declared = new Map(propertiesOf(schema));
  const secret = (key: string): boolean => isSecret(declared.get(key) ?? {});
  const keys = Object.keys(accepted);
  const values = Object.fromEntries([
    ...Object.entries(record.values).filter(([key]) => !keys.includes(key)),
    ...Object.entries(accepted).filter(([key]) => !secret(key)),
  ]);
  const secrets = Object.fromEntries([
    ...Object.entries(record.secrets).filter(([key]) => !keys.includes(key)),
    ...Object.entries(accepted).filter(
      (entry): entry is [string, string] => secret(entry[0]) && typeof entry[1] === "string",
    ),
  ]);
  const written = {
    ...record.written,
    ...Object.fromEntries(keys.map((key) => [key, { by, at }])),
  };
  return { values, secrets, written };
}

/**
 * What the person may not set of `values` (Setup's Continue): a property nobody declares, and
 * one only its package sets (`reload.writtenBy: "plugin"`), each by its pointer.
 */
export function personRefusals(
  schema: JsonSchema,
  values: Readonly<Record<string, unknown>>,
  secrets: ReadonlySet<string>,
): FieldProblem[] {
  const declared = new Map(propertiesOf(schema));
  // A secret is named by its path ("account.token"), and the credential its value goes to.
  return Object.keys(values).flatMap((key) => {
    const property = declared.get(key);
    if (property === undefined) {
      return secrets.has(key) ? [] : [{ path: `/${key}`, message: "is not a declared property" }];
    }
    return writtenBy(property) === "plugin"
      ? [{ path: `/${key}`, message: "is set by its package, never by the person" }]
      : [];
  });
}

/** The node property that holds when the person last changed each top-level property. */
export const WRITTEN_KEY = "reload.written";

/** When the person last changed each property, as a node holds it; empty when it holds none. */
export function personWrites(node: Readonly<Record<string, unknown>>): Record<string, string> {
  const stamps = node[WRITTEN_KEY];
  return isRecord(stamps)
    ? Object.fromEntries(
        Object.entries(stamps).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
}

/**
 * The person's stamps after a save: `before`'s, with now for each top-level key whose value the
 * save changed (`old` the node's values before, `saved` after). Undefined with nothing changed.
 */
export function stamped(
  before: Readonly<Record<string, string>>,
  old: Readonly<Record<string, unknown>>,
  saved: Readonly<Record<string, unknown>>,
  at: string,
): Record<string, string> | undefined {
  // A field nobody filled reads back as empty text: no change of the person's.
  const changed = Object.keys(saved).filter(
    (key) => JSON.stringify(old[key] ?? "") !== JSON.stringify(saved[key] ?? ""),
  );
  return changed.length === 0
    ? undefined
    : { ...before, ...Object.fromEntries(changed.map((key) => [key, at])) };
}

/** The node's stamps after Setup saved `saved` over it, as a node field; none when unchanged. */
export function personStamp(
  node: Readonly<Record<string, unknown>>,
  saved: Readonly<Record<string, unknown>>,
  at: string,
): Record<string, Record<string, string>> {
  const stamps = stamped(personWrites(node), node, saved, at);
  return stamps === undefined ? {} : { [WRITTEN_KEY]: stamps };
}

/**
 * The keys of `record` that may still be in force: written by `own` (the instance's package)
 * and declared by the current schema as its package's to set (`reload.writtenBy`). A key it
 * wrote before an update stopped letting it, or one in another's name, is never merged.
 */
function inForce(record: WrittenRecord, schema: JsonSchema, own: string): string[] {
  const declared = new Map(propertiesOf(schema));
  return Object.entries(record.written)
    .filter(([key, written]) => {
      const property = declared.get(key);
      return written.by === own && property !== undefined && writtenBy(property) !== null;
    })
    .map(([key]) => key);
}

/** Whether the node's write of `key` is later than the person's own last change of it. */
const later = (record: WrittenRecord, person: Readonly<Record<string, string>>, key: string) => {
  const theirs = person[key];
  const at = record.written[key]?.at ?? "";
  return theirs === undefined || theirs <= at;
};

/**
 * The config and credentials an instance starts with: what a node of package `own` wrote merged
 * over what the person deployed, property by property, wherever its write is still in force
 * (`inForce`) and later than the person's own last change of it (`person`, the node's stamps).
 */
export function withWritten(
  config: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, string>>,
  record: WrittenRecord,
  person: Readonly<Record<string, string>>,
  schema: JsonSchema,
  own: string,
): { config: Record<string, unknown>; credentials: Record<string, string> } {
  const merged = { config: { ...config }, credentials: { ...credentials } };
  for (const key of inForce(record, schema, own).filter((each) => later(record, person, each))) {
    const secret = record.secrets[key];
    if (secret !== undefined) {
      merged.credentials[key] = secret;
    } else if (key in record.values) {
      merged.config[key] = record.values[key];
    }
  }
  return merged;
}

/**
 * What the person sent, without the package's own value echoed back (Setup and the canvas show
 * the value in force, which may be the package's): a key whose value is the package's value in
 * force is the node's own again, so it is neither written into the flows nor stamped the
 * person's.
 */
export function withoutEcho(
  values: Readonly<Record<string, unknown>>,
  node: Readonly<Record<string, unknown>>,
  record: WrittenRecord,
  schema: JsonSchema,
  own: string,
): Record<string, unknown> {
  const person = personWrites(node);
  const echoed = new Set(
    inForce(record, schema, own).filter(
      (key) =>
        later(record, person, key) &&
        key in values &&
        JSON.stringify(values[key]) === JSON.stringify(record.values[key]),
    ),
  );
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]): [string, unknown][] => {
      if (!echoed.has(key)) {
        return [[key, value]];
      }
      return key in node ? [[key, node[key]]] : [];
    }),
  );
}

/**
 * Who set each property, for the editor and Setup: the package's record where its write is in
 * force and the later one, else the person's stamp. A secret's value is never in it.
 */
export function attributionOf(
  record: WrittenRecord,
  person: Readonly<Record<string, string>>,
  schema: JsonSchema,
  own: string,
): Record<string, WrittenBy> {
  const by: Record<string, WrittenBy> = Object.fromEntries(
    Object.entries(person).map(([key, at]) => [key, { by: USER, at }]),
  );
  for (const key of inForce(record, schema, own).filter((each) => later(record, person, each))) {
    by[key] = record.written[key] as WrittenBy;
  }
  return by;
}

/** Node-RED's placeholder for a credential the editor did not change. */
const UNCHANGED_SECRET = "__PWRD__";

/**
 * A deployment's nodes, each generated one stamped with when the person changed its properties:
 * now (`at`, the deploy), for each top-level property `declared` names whose value differs from
 * the deployed node's, and each credential it carries a new value for. The person's change
 * takes effect at the deploy, so a write its package makes before then is still overruled by
 * it, and one after it overrules it (spec 4.6). A node not deployed before is left as it came.
 */
export function stampedAtDeploy(
  incoming: readonly unknown[],
  deployed: readonly unknown[],
  declared: (type: string) => ReadonlySet<string> | null,
  at: string,
): unknown[] {
  const isNode = (value: unknown): value is Readonly<Record<string, unknown>> =>
    isRecord(value) && typeof value["id"] === "string" && typeof value["type"] === "string";
  const before = new Map(deployed.filter(isNode).map((node) => [node["id"] as string, node]));
  return incoming.map((node) => {
    const keys = isNode(node) ? declared(node["type"] as string) : null;
    const old = isNode(node) ? before.get(node["id"] as string) : undefined;
    if (!isNode(node) || keys === null || old === undefined || old["type"] !== node["type"]) {
      return node;
    }
    const given = isRecord(node["credentials"]) ? node["credentials"] : {};
    const secrets = Object.entries(given)
      .filter(([key, value]) => keys.has(key) && typeof value === "string")
      .filter(([, value]) => value !== "" && value !== UNCHANGED_SECRET)
      .map(([key]) => key);
    const plain = [...keys].filter(
      (key) => JSON.stringify(old[key] ?? "") !== JSON.stringify(node[key] ?? ""),
    );
    const changed = [...new Set([...plain, ...secrets])];
    if (changed.length === 0) {
      return node;
    }
    const stamps = { ...personWrites(old), ...personWrites(node) };
    return {
      ...node,
      [WRITTEN_KEY]: { ...stamps, ...Object.fromEntries(changed.map((key) => [key, at])) },
    };
  });
}
