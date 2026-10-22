// What a save of the canvas form keeps (the old settings store's rule, plan 0005 D2).
//
// A save never puts a value its schema refuses over a good one. Each field is judged on its
// own: a field that passes is recorded, a field that fails keeps the value it had (none, when it
// had none). A table is judged row by row, by position: a row that fails keeps the row that was
// at its place before, kept whole, or is left out when there was none; a failure inside a
// nested table refuses only the nested row, the same way, all the way down. So one bad entry
// never stops the node, and never costs a good row. What was refused is said, by field, so the
// person can be shown what they typed and why it was not kept.
//
// Pure: no I/O, no DOM, no library; the schema is judged by the `check` handed in.

import type { JsonSchema } from "../packages/declaration";
import { coerceObject } from "./coerce";
import { propertiesOf, rowSchemaOf } from "./form-model";

/** One refusal: the JSON Pointer of the value, and what is wrong with it. */
export interface Problem {
  readonly path: string;
  readonly message: string;
}

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
 * object, coerced as the runtime will coerce it. A key the schema does not declare is never
 * taken from the submission: what was there stays.
 */
export function keptOnSave(
  schema: JsonSchema,
  previous: Values,
  submitted: Values,
  check: (value: Values) => readonly Problem[],
): Kept {
  const problems = check(coerceObject(schema, submitted));
  const { value, refused } = keptObject(schema, previous, submitted, problems, "");
  return { values: value, refused };
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
): { value: Record<string, unknown>; refused: Problem[] } {
  const value = new Map(Object.entries(previous));
  const refused: Problem[] = [];
  for (const [key, property] of propertiesOf(schema)) {
    if (!(key in submitted)) {
      continue;
    }
    const path = `${at}/${key}`;
    const kept = keptField(property, previous[key], submitted[key], under(problems, path), path);
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
): Judged {
  if (problems.length === 0) {
    return { value: given, refused: [] };
  }
  const whole = problems.some((problem) => problem.path === path);
  if (!whole && property["type"] === "object" && isRecord(given)) {
    return keptObject(property, isRecord(previous) ? previous : {}, given, problems, path);
  }
  const rows = rowSchemaOf(property);
  if (!whole && rows !== null && Array.isArray(given)) {
    return keptRows(rows, Array.isArray(previous) ? previous : [], given, problems, path);
  }
  return { value: previous, refused: problems };
}

/** A table, row by row: each failing row replaced by the one at its place before, if any. */
function keptRows(
  rows: JsonSchema,
  previous: readonly unknown[],
  given: readonly unknown[],
  problems: readonly Problem[],
  path: string,
): Judged {
  const tables = propertiesOf(rows).filter(([, column]) => rowSchemaOf(column) !== null);
  const value: unknown[] = [];
  const refused: Problem[] = [];
  given.forEach((row, index) => {
    const rowPath = `${path}/${String(index)}`;
    const mine = under(problems, rowPath);
    const before = previous[index];
    if (mine.length === 0) {
      value.push(row);
      return;
    }
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
    const kept: Record<string, unknown> = { ...row };
    const old = isRecord(before) ? before : {};
    for (const [key, column] of tables) {
      const cell = `${rowPath}/${key}`;
      const judged = keptField(column, old[key], row[key], under(mine, cell), cell);
      kept[key] = judged.value ?? [];
      refused.push(...judged.refused);
    }
    value.push(kept);
  });
  return { value, refused };
}

/**
 * What the editor says after a save that kept something back: what was refused, in the
 * person's words (describedProblems), and that the value before stayed.
 */
export function notKeptSentence(described: string): string {
  return `Not saved: ${described} The value each had before is kept.`;
}
