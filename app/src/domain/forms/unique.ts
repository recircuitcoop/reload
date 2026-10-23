// A table's unique column (`reload.unique`, plan 0032 group 4; the old plan 0005 D3): no two
// rows may hold the same value in it. Each row repeating another's is refused, naming the other,
// so the person sees both; a row that leaves the column empty is compared with nobody, since a
// value nobody typed is no identity two rows could share.
//
// Pure: no I/O, no library.

import type { JsonSchema } from "../packages/declaration";
import { propertiesOf, rowSchemaOf } from "./form-model";
import { isUnique } from "./reload-keyword";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A cell's value as compared: text, a number or a choice; null for an empty one. */
function identity(value: unknown): string | null {
  if (typeof value === "string") {
    return value === "" ? null : value;
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

/**
 * Every cell of a unique column that repeats another row's, at every depth (a group, a row's
 * nested table), by its pointer ("/volumes/2/label"), each naming the rows it repeats.
 */
export function uniqueClashes(
  schema: JsonSchema,
  value: unknown,
  path = "",
): { path: string; message: string }[] {
  if (!isRecord(value)) {
    return [];
  }
  return propertiesOf(schema).flatMap(([key, property]) => {
    const at = `${path}/${key}`;
    const given = value[key];
    const row = rowSchemaOf(property);
    if (row === null) {
      return property["type"] === "object" ? uniqueClashes(property, given, at) : [];
    }
    const rows = Array.isArray(given) ? given : [];
    const noun = typeof row["title"] === "string" && row["title"] !== "" ? row["title"] : "row";
    const clashes = propertiesOf(row)
      .filter(([, column]) => isUnique(column))
      .flatMap(([column]) => {
        const held = rows.map((each: unknown) => (isRecord(each) ? identity(each[column]) : null));
        return held.flatMap((one, index) => {
          const others = held.flatMap((other, at_) =>
            one !== null && other === one && at_ !== index ? [`${noun} ${String(at_ + 1)}`] : [],
          );
          return others.length === 0
            ? []
            : [
                {
                  path: `${at}/${String(index)}/${column}`,
                  message: `${JSON.stringify(one)} is also in ${others.join(" and ")}: each must be different`,
                },
              ];
        });
      });
    const deeper = rows.flatMap((each: unknown, index) =>
      uniqueClashes(row, each, `${at}/${String(index)}`),
    );
    return [...clashes, ...deeper];
  });
}
