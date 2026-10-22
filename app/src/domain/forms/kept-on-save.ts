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
}

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The problems at `path` or anywhere under it. */
function under(problems: readonly Problem[], path: string): Problem[] {
  return problems.filter(({ path: at }) => at === path || at.startsWith(`${path}/`));
}

/**
 * The values to keep when `submitted` is saved over `previous`. `check` judges the whole
 * object, coerced as the runtime will coerce it; `origins` matches each table's rows.
 */
export function keptOnSave(
  schema: JsonSchema,
  previous: Values,
  submitted: Values,
  check: (value: Values) => readonly Problem[],
  origins: RowOrigins,
): Kept {
  const problems = check(coerceObject(schema, submitted));
  const { value, refused } = keptObject(schema, previous, submitted, problems, "", origins);
  return {
    values: value,
    refused: refused.map((problem) => {
      const typed = valueAt(submitted, problem.path);
      return typed === undefined ? problem : { ...problem, value: typed };
    }),
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

interface Judged {
  /** Undefined: nothing is kept, and the key is left out. */
  readonly value: unknown;
  readonly refused: readonly Problem[];
}

function keptObject(
  schema: JsonSchema,
  previous: Values,
  submitted: Values,
  problems: readonly Problem[],
  at: string,
  origins: RowOrigins,
): { value: Record<string, unknown>; refused: Problem[] } {
  // Everything it had stays unless a declared field replaces it: undeclared values included.
  const value = new Map(Object.entries(previous));
  const refused: Problem[] = [];
  const declared = new Map(propertiesOf(schema));
  for (const key of Object.keys(submitted).filter((each) => !declared.has(each))) {
    refused.push({ path: `${at}/${key}`, message: "is not a declared property" });
  }
  for (const [key, property] of declared) {
    if (!(key in submitted)) {
      continue;
    }
    const path = `${at}/${key}`;
    const mine = under(problems, path);
    const kept = keptField(property, previous[key], submitted[key], mine, path, origins);
    if (kept.value === undefined) {
      value.delete(key);
    } else {
      value.set(key, kept.value);
    }
    refused.push(...kept.refused);
  }
  return { value: Object.fromEntries(value), refused };
}

function keptField(
  property: JsonSchema,
  previous: unknown,
  given: unknown,
  problems: readonly Problem[],
  path: string,
  origins: RowOrigins,
): Judged {
  const whole = problems.some((problem) => problem.path === path);
  if (whole) {
    return { value: previous, refused: problems };
  }
  if (property["type"] === "object" && isRecord(given)) {
    const before = isRecord(previous) ? previous : {};
    return keptObject(property, before, given, problems, path, origins);
  }
  const rows = rowSchemaOf(property);
  if (rows !== null && Array.isArray(given)) {
    const before = Array.isArray(previous) ? previous : [];
    return keptRows(rows, before, given, problems, path, origins);
  }
  return problems.length === 0
    ? { value: given, refused: [] }
    : { value: previous, refused: problems };
}

/** A table, row by row: each row judged against the row it was drawn from. */
function keptRows(
  rows: JsonSchema,
  previous: readonly unknown[],
  given: readonly unknown[],
  problems: readonly Problem[],
  path: string,
  origins: RowOrigins,
): Judged {
  const from = origins.get(path);
  if (from === undefined) {
    // Rows nobody can match: the table is taken whole, or kept whole when any row fails.
    return problems.length === 0
      ? { value: given, refused: [] }
      : { value: previous, refused: problems };
  }
  const tables = propertiesOf(rows).filter(([, column]) => rowSchemaOf(column) !== null);
  const value: unknown[] = [];
  const refused: Problem[] = [];
  given.forEach((row, index) => {
    const rowPath = `${path}/${String(index)}`;
    const mine = under(problems, rowPath);
    const origin = from[index] ?? null;
    const before = origin === null ? undefined : previous[origin];
    // Problems inside a nested table's rows are that table's to judge; any other refuses the row.
    const nested = (problem: Problem) =>
      isRecord(row) &&
      tables.some(
        ([key]) => Array.isArray(row[key]) && problem.path.startsWith(`${rowPath}/${key}/`),
      );
    if (!isRecord(row) || !mine.every(nested)) {
      if (before !== undefined) {
        value.push(before);
      }
      refused.push(...mine);
      return;
    }
    const kept = keptObject(rows, isRecord(before) ? before : {}, row, mine, rowPath, origins);
    for (const [key] of tables) {
      // A nested table every row of which was refused, in a row that had none, is empty.
      if (Array.isArray(row[key]) && kept.value[key] === undefined) {
        kept.value[key] = [];
      }
    }
    value.push(kept.value);
    refused.push(...kept.refused);
  });
  return { value, refused };
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
