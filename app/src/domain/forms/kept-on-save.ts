// What a save of the canvas form keeps (the old settings store's rule, plan 0005 D2).
//
// A save never puts a value its schema refuses over a good one. Each field is judged on its
// own: a field that passes is recorded, a field that fails keeps the value it had (none, when it
// had none). A table is judged row by row, each row matched to the row it was drawn from (the
// form says which, as `RowOrigins`), never by its place: a row that fails keeps that row whole,
// wherever it now stands, or is left out when it was added in this save; a failure inside a
// nested table refuses only the nested row, the same way, all the way down. A table whose rows
// the form cannot match keeps the table it had when any row fails. So one bad entry never
// stops the node, never costs a good row, and never brings back a row the person removed.
//
// Values the schema does not declare are kept at every depth: in a group, and in a row matched
// to the row it came from. A submitted value for a property nobody declares is refused, never
// recorded. What was refused is said, by field and with what was typed, so the person can see
// it and why it was not kept.
//
// Pure: no I/O, no DOM, no library; the schema is judged by the `check` handed in.

import type { JsonSchema } from "../packages/declaration";
import { coerceObject } from "./coerce";
import { describedProblems, propertiesOf, rowSchemaOf } from "./form-model";

/** One refusal: the JSON Pointer of the value, and what is wrong with it. */
export interface Problem {
  readonly path: string;
  readonly message: string;
  /** What was typed there, when anything was. */
  readonly value?: unknown;
}

/**
 * Where each submitted row of a table was drawn from: its index in that table before the save,
 * or null for a row added in it. Keyed by the table's JSON Pointer in the submission
 * ("/volumes", "/volumes/0/takes").
 */
export type RowOrigins = ReadonlyMap<string, readonly (number | null)[]>;

type Values = Readonly<Record<string, unknown>>;

export interface Kept {
  /** The values to keep: the passing ones submitted, the old ones where a field failed. */
  readonly values: Record<string, unknown>;
  /** What was not kept, by the path of what was submitted. */
  readonly refused: readonly Problem[];
  /** Values the schema no longer allows where they were, left out by this save. */
  readonly dropped: readonly string[];
  /**
   * Where each submitted row now stands in the kept values, by the submitted table's pointer:
   * what the form, showing the submission again, matches its rows by on the next save.
   */
  readonly origins: RowOrigins;
}

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The problems at `path` or anywhere under it. */
function under(problems: readonly Problem[], path: string): Problem[] {
  return problems.filter(({ path: at }) => at === path || at.startsWith(`${path}/`));
}

/** What one level of the judging found, beside the value it keeps. */
interface Found {
  readonly refused: Problem[];
  readonly dropped: string[];
  readonly origins: Map<string, (number | null)[]>;
}

const nothing = (): Found => ({ refused: [], dropped: [], origins: new Map() });

/**
 * The values to keep when `submitted` is saved over `previous`. `check` judges the whole
 * object, coerced as the runtime will coerce it; `origins` matches each table's rows. A refusal
 * of the whole object (a dependentRequired, anyOf, not or minProperties at the top) keeps
 * everything as it was.
 */
export function keptOnSave(
  schema: JsonSchema,
  previous: Values,
  submitted: Values,
  check: (value: Values) => readonly Problem[],
  origins: RowOrigins,
): Kept {
  const problems = check(coerceObject(schema, submitted));
  const typed = (problem: Problem): Problem => {
    // The form as a whole was refused: what was typed is the whole form, said field by field.
    const value = problem.path === "" ? undefined : valueAt(submitted, problem.path);
    return value === undefined ? problem : { ...problem, value };
  };
  if (problems.some((problem) => problem.path === "")) {
    return {
      values: { ...previous },
      refused: problems.map(typed),
      dropped: [],
      origins: new Map(),
    };
  }
  const found = nothing();
  const value = keptObject(schema, previous, submitted, problems, "", origins, found);
  return {
    values: value,
    refused: found.refused.map(typed),
    dropped: found.dropped,
    origins: found.origins,
  };
}

/** The value at a JSON Pointer of keys and indexes; undefined past it. */
function valueAt(value: unknown, path: string): unknown {
  let at = value;
  for (const segment of path.split("/").slice(1)) {
    at = Array.isArray(at) ? at[Number(segment)] : isRecord(at) ? at[segment] : undefined;
  }
  return at;
}

/** Whether an object schema forbids keys it does not name. */
const closed = (schema: JsonSchema): boolean =>
  schema["additionalProperties"] === false || schema["unevaluatedProperties"] === false;

function keptObject(
  schema: JsonSchema,
  previous: Values,
  submitted: Values,
  problems: readonly Problem[],
  at: string,
  origins: RowOrigins,
  found: Found,
): Record<string, unknown> {
  const declared = new Map(propertiesOf(schema));
  // Everything it had stays unless a declared field replaces it, undeclared values included,
  // except where the schema forbids them: those are left out, and said.
  const value = new Map(
    Object.entries(previous).filter(([key]) => {
      const keep = declared.has(key) || !closed(schema);
      if (!keep) {
        found.dropped.push(`${at}/${key}`);
      }
      return keep;
    }),
  );
  for (const key of Object.keys(submitted).filter((each) => !declared.has(each))) {
    found.refused.push({ path: `${at}/${key}`, message: "is not a declared property" });
  }
  for (const [key, property] of declared) {
    // A read-only value is shown, never typed over: what it had stays.
    if (!(key in submitted) || property["readOnly"] === true) {
      continue;
    }
    const path = `${at}/${key}`;
    const mine = under(problems, path);
    const kept = keptField(property, previous[key], submitted[key], mine, path, origins, found);
    if (kept === undefined) {
      value.delete(key);
    } else {
      value.set(key, kept);
    }
  }
  return Object.fromEntries(value);
}

/** The value to keep of one field; undefined: nothing is kept, and the key is left out. */
function keptField(
  property: JsonSchema,
  previous: unknown,
  given: unknown,
  problems: readonly Problem[],
  path: string,
  origins: RowOrigins,
  found: Found,
): unknown {
  if (problems.some((problem) => problem.path === path)) {
    found.refused.push(...problems);
    return previous;
  }
  if (property["type"] === "object" && isRecord(given)) {
    const before = isRecord(previous) ? previous : {};
    return keptObject(property, before, given, problems, path, origins, found);
  }
  const rows = rowSchemaOf(property);
  if (rows !== null && Array.isArray(given)) {
    const before = Array.isArray(previous) ? previous : [];
    return keptRows(rows, before, given, problems, path, origins, found);
  }
  if (problems.length === 0) {
    return given;
  }
  found.refused.push(...problems);
  return previous;
}

/** The pointers, below a row, of the tables in it, through its groups, that hold rows. */
function tablesIn(schema: JsonSchema, row: Values, at = ""): string[] {
  return propertiesOf(schema).flatMap(([key, property]) => {
    const inner = row[key];
    if (rowSchemaOf(property) !== null) {
      return Array.isArray(inner) ? [`${at}/${key}`] : [];
    }
    return property["type"] === "object" && isRecord(inner)
      ? tablesIn(property, inner, `${at}/${key}`)
      : [];
  });
}

/** A table, row by row: each row judged against the row it was drawn from. */
function keptRows(
  rows: JsonSchema,
  previous: readonly unknown[],
  given: readonly unknown[],
  problems: readonly Problem[],
  path: string,
  origins: RowOrigins,
  found: Found,
): unknown[] {
  const from = origins.get(path);
  if (from === undefined) {
    // Rows nobody can match: the table is taken whole, or kept whole when any row fails.
    found.refused.push(...problems);
    return problems.length === 0 ? [...given] : [...previous];
  }
  const value: unknown[] = [];
  const now: (number | null)[] = [];
  given.forEach((row, index) => {
    const rowPath = `${path}/${String(index)}`;
    const mine = under(problems, rowPath);
    const origin = from[index] ?? null;
    const before = origin === null ? undefined : previous[origin];
    // Problems inside a nested table's rows, at any depth through the row's groups, are that
    // table's to judge; any other refuses the row.
    const tables = isRecord(row) ? tablesIn(rows, row).map((table) => `${rowPath}${table}/`) : [];
    const nested = (problem: Problem) => tables.some((table) => problem.path.startsWith(table));
    if (!isRecord(row) || !mine.every(nested)) {
      found.refused.push(...mine);
      if (before !== undefined) {
        now.push(value.length);
        value.push(before);
      } else {
        now.push(null);
      }
      return;
    }
    const old = isRecord(before) ? before : {};
    const kept = keptObject(rows, old, row, mine, rowPath, origins, found);
    for (const [key, column] of propertiesOf(rows)) {
      // A nested table every row of which was refused, in a row that had none, is empty.
      if (rowSchemaOf(column) !== null && Array.isArray(row[key]) && kept[key] === undefined) {
        kept[key] = [];
      }
    }
    now.push(value.length);
    value.push(kept);
  });
  found.origins.set(path, now);
  return value;
}

/**
 * What the editor says after a save that kept something back: each refusal in the person's
 * words (describedProblems), with what was typed, and that the value before stayed.
 */
export function notKeptSentence(schema: JsonSchema, refused: readonly Problem[]): string {
  const said = refused.map((problem) => {
    const described = describedProblems(schema, [problem]);
    const { value } = problem;
    return value === undefined || value === ""
      ? described
      : `${described.slice(0, -1)}, not ${JSON.stringify(value)}.`;
  });
  return `Not saved: ${said.join(" ")} The value each had before is kept.`;
}

/**
 * What a save left out because the schema no longer allows it there, for the person: each by
 * its key spaced ("old cell"), where it was.
 */
export function droppedSentence(dropped: readonly string[]): string {
  const names = dropped.map((path) => (path.split("/").at(-1) ?? "").replaceAll("_", " "));
  return `Left out, as the step no longer takes ${names.length === 1 ? "it" : "them"}: ${names.join(", ")}.`;
}

/**
 * The node property a refused save is kept in until it is corrected: what was typed, why each
 * part was refused, and where each typed row now stands, so the form shows it again after a
 * reopen or a reload of the editor and its next save matches every row. A property name holds
 * no dot (declaration.ts), so no package can declare this one. It never holds a secret: secrets
 * are never read back from the form.
 */
export const REFUSED_KEY = "reload.refused";

export interface StoredRefusal {
  readonly values: Readonly<Record<string, unknown>>;
  readonly problems: readonly Problem[];
  readonly origins: readonly (readonly [string, readonly (number | null)[]])[];
}

/** The refusal to keep on the node after a save; null when nothing was refused. */
export function storedRefusal(submitted: Values, kept: Kept): StoredRefusal | null {
  return kept.refused.length === 0
    ? null
    : { values: submitted, problems: kept.refused, origins: [...kept.origins] };
}

/** A refusal read back from a node; null for anything not of its shape. */
export function readRefusal(raw: unknown): StoredRefusal | null {
  if (!isRecord(raw) || !isRecord(raw["values"])) {
    return null;
  }
  const { problems, origins } = raw;
  const problem = (each: unknown) =>
    isRecord(each) && typeof each["path"] === "string" && typeof each["message"] === "string";
  const rows = (each: unknown) =>
    Array.isArray(each) &&
    typeof each[0] === "string" &&
    Array.isArray(each[1]) &&
    (each[1] as unknown[]).every((index) => index === null || typeof index === "number");
  if (!Array.isArray(problems) || !problems.every(problem)) {
    return null;
  }
  if (!Array.isArray(origins) || !origins.every(rows)) {
    return null;
  }
  return raw as unknown as StoredRefusal;
}
