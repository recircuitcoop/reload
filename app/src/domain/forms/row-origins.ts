// Which stored row each row of a form was drawn from, for kept-on-save.ts to match rows by it
// rather than by their place. The form remembers it per row object (`Origins`, a WeakMap in the
// editor): seeded from the node's own rows as the form opens, carried by every move, and absent
// for a row added since.
//
// Pure: no I/O, no DOM, no library.

import type { Field } from "./form-model";
import type { RowOrigins } from "./kept-on-save";

/** Where a row object was drawn from, as the form keeps it. */
export interface Origins {
  get(row: object): number | undefined;
  set(row: object, index: number): unknown;
}

type Values = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A group's fields or a table's columns (the form model always gives them). */
const columnsOf = (field: Field): readonly Field[] => field.fields ?? [];

/** Each stored row of `values`' tables, at every depth, as drawn from its own index. */
export function seedOrigins(fields: readonly Field[], values: Values, origins: Origins): void {
  for (const field of fields) {
    const value = values[field.key];
    if (field.control === "group" && isRecord(value)) {
      seedOrigins(columnsOf(field), value, origins);
    }
    if (field.control === "table" && Array.isArray(value)) {
      value.forEach((row: unknown, index) => {
        if (isRecord(row)) {
          origins.set(row, index);
          seedOrigins(columnsOf(field), row, origins);
        }
      });
    }
  }
}

/** Each table's row origins in `values` (as read back from the form), by its JSON Pointer. */
export function originsOf(
  fields: readonly Field[],
  values: Values,
  origins: Origins,
  at = "",
): RowOrigins {
  const found = new Map<string, readonly (number | null)[]>();
  for (const field of fields) {
    const value = values[field.key];
    const path = `${at}/${field.key}`;
    if (field.control === "group" && isRecord(value)) {
      for (const [key, rows] of originsOf(columnsOf(field), value, origins, path)) {
        found.set(key, rows);
      }
    }
    if (field.control === "table" && Array.isArray(value)) {
      found.set(
        path,
        value.map((row: unknown) => (isRecord(row) ? (origins.get(row) ?? null) : null)),
      );
      value.forEach((row: unknown, index) => {
        if (!isRecord(row)) {
          return;
        }
        const rowPath = `${path}/${String(index)}`;
        for (const [key, nested] of originsOf(columnsOf(field), row, origins, rowPath)) {
          found.set(key, nested);
        }
      });
    }
  }
  return found;
}
