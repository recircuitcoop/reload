// A property `reload.shown` hides is not judged while it is hidden (plan 0032, group 2): neither
// its value nor whether it is required, wherever a value is judged (the runtime's start, Setup,
// whether a step is set up, the canvas form's save and the reasons it draws). Otherwise a
// required property hidden by its condition could never be filled, and its step never set up.
// The old app judged a hidden field like any other; the owner's rule for this one is ours.
//
// Pure: no I/O, no library.

import type { JsonSchema } from "../packages/declaration";
import { propertiesOf, rowSchemaOf } from "./form-model";
import { conditionHolds, shownWhen } from "./reload-keyword";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON pointers of every property hidden for `value` (already of its schema's types), at
 * every depth: the top, a group, each row of a table, each judged against its own object. A
 * condition's sibling left out is judged by its default.
 */
export function hiddenPaths(schema: JsonSchema, value: unknown, path = ""): string[] {
  const own = isRecord(value) ? value : {};
  const properties = propertiesOf(schema);
  return properties.flatMap(([key, property]) => {
    const at = `${path}/${key}`;
    const shown = shownWhen(property);
    if (shown !== null) {
      const sibling = properties.find(([name]) => name === shown.when)?.[1];
      const held = shown.when in own ? own[shown.when] : sibling?.["default"];
      if (!conditionHolds(shown, held)) {
        return [at];
      }
    }
    const given = own[key];
    const row = rowSchemaOf(property);
    if (row !== null && Array.isArray(given)) {
      return given.flatMap((each: unknown, index) =>
        hiddenPaths(row, each, `${at}/${String(index)}`),
      );
    }
    return property["type"] === "object" ? hiddenPaths(property, given, at) : [];
  });
}

/** `problems` without those about a hidden property or anything inside one. */
export function unhidden<T extends { readonly path: string }>(
  problems: readonly T[],
  hidden: readonly string[],
): T[] {
  return problems.filter(
    ({ path }) => !hidden.some((at) => path === at || path.startsWith(`${at}/`)),
  );
}
