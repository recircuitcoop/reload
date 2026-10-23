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

/** Who may set a property besides the person: the node only, or either. */
export type Writer = "plugin" | "both";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A property's `reload.writtenBy`; null when only the person sets it. */
export const writtenByOf = writtenBy;

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
    if (writtenByOf(property) === null) {
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
  const changed = Object.keys(saved).filter(
    (key) => JSON.stringify(old[key]) !== JSON.stringify(saved[key]),
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
 * The config and credentials an instance starts with: what a node wrote merged over what the
 * person deployed, property by property, wherever the node's write is later than the person's
 * own last change of it (`person`, from the node's stamps).
 */
export function withWritten(
  config: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, string>>,
  record: WrittenRecord,
  person: Readonly<Record<string, string>>,
): { config: Record<string, unknown>; credentials: Record<string, string> } {
  const merged = { config: { ...config }, credentials: { ...credentials } };
  for (const [key, { at }] of Object.entries(record.written)) {
    const theirs = person[key];
    if (theirs !== undefined && theirs > at) {
      continue;
    }
    if (key in record.secrets) {
      merged.credentials[key] = record.secrets[key] as string;
    } else if (key in record.values) {
      merged.config[key] = record.values[key];
    }
  }
  return merged;
}

/**
 * Who set each property, for the editor and Setup: the node's record where it is the later
 * write, else the person's stamp. A secret's value is never in it, only that it is set.
 */
export function attributionOf(
  record: WrittenRecord,
  person: Readonly<Record<string, string>>,
): Record<string, WrittenBy> {
  const by: Record<string, WrittenBy> = Object.fromEntries(
    Object.entries(person).map(([key, at]) => [key, { by: USER, at }]),
  );
  for (const [key, written] of Object.entries(record.written)) {
    const theirs = person[key];
    if (theirs === undefined || theirs <= written.at) {
      by[key] = written;
    }
  }
  return by;
}
