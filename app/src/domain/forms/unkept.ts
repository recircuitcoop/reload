// Secrets no credential can hold (the old secret store's refusal; the parity ledger cites its
// code and tests, tests/test_plugin_secrets.py and tests/test_table_store.py): Node-RED keeps
// a node's secrets by name, so a secret in a table's rows, a list of secrets, a secret under
// `additionalProperties`, or one only an `anyOf`/`oneOf`/`allOf` branch declares has nowhere to
// live. The declaration is accepted and the form draws such a secret, but a value for it is
// refused where it would be kept: by the form's save, and by the runtime for a flow that holds
// one (hand-edited, or imported), which starts nothing rather than hand it over. It never
// reaches the plain config (form-model.ts withoutSecrets, coerce.ts declaredOnly).
//
// Pure: no I/O, no library.

import type { JsonSchema } from "../packages/declaration";
import { containsSecret, isSecret, isSecretList, propertiesOf, withoutSecrets } from "./form-model";

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const held = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

/** The properties an object schema's branches declare, beside its own. */
function branchProperties(schema: JsonSchema): [string, JsonSchema][] {
  return ["anyOf", "oneOf", "allOf"].flatMap((keyword) => {
    const branches = schema[keyword];
    return Array.isArray(branches)
      ? branches.filter(isRecord).flatMap((branch) => propertiesOf(branch))
      : [];
  });
}

/**
 * The paths ("volumes.0.token", "keys", "extra.k") at which `value` holds a secret no
 * credential can hold, by `schema`. `inRow`: the object is (inside) a table's row.
 */
export function unkeptSecrets(
  schema: JsonSchema,
  value: unknown,
  path = "",
  inRow = false,
): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const at = (key: string) => (path === "" ? key : `${path}.${key}`);
  const own = propertiesOf(schema);
  const declared = new Set(own.map(([key]) => key));
  const found: string[] = [];
  for (const [key, property] of own) {
    const inner = value[key];
    const items = property["items"];
    if (isSecret(property)) {
      if (inRow && held(inner)) {
        found.push(at(key));
      }
    } else if (isSecretList(property)) {
      if (held(inner)) {
        found.push(at(key));
      }
    } else if (isRecord(items) && Array.isArray(inner)) {
      inner.forEach((row: unknown, index) => {
        found.push(...unkeptSecrets(items, row, `${at(key)}.${String(index)}`, true));
      });
    } else {
      found.push(...unkeptSecrets(property, inner, at(key), inRow));
    }
  }
  // Keys no property names: a secret `additionalProperties`, or a branch's secret property.
  const extra = schema["additionalProperties"];
  const branches = new Map(branchProperties(schema));
  for (const [key, inner] of Object.entries(value)) {
    if (declared.has(key) || !held(inner)) {
      continue;
    }
    const branch = branches.get(key);
    if ((branch !== undefined && isSecret(branch)) || (isRecord(extra) && isSecret(extra))) {
      found.push(at(key));
    }
  }
  return found;
}

/**
 * The same for a Node-RED node's own fields: only the keys its top-level schema or one of its
 * branches names are judged, since the node also carries Node-RED's own (id, type, wires…).
 */
export function unkeptSecretsOfNode(schema: JsonSchema, node: Fields): string[] {
  const named = new Set([...propertiesOf(schema), ...branchProperties(schema)].map(([key]) => key));
  const own = Object.fromEntries(Object.entries(node).filter(([key]) => named.has(key)));
  return unkeptSecrets(schema, own);
}

/**
 * `value` with every value a secret may hold taken out, by the type's whole schema: what the
 * plain schema (form-model.ts withoutSecrets) declares is kept, at every depth, so a group's or
 * a row's other values stay and only its secrets go; a field holding a secret in a shape the form
 * cannot strip is left out whole, and so are keys no property names when anything but
 * `properties` declares a secret. What is left holds no secret, whatever shape a package declared.
 */
export function withoutSecretValues(schema: JsonSchema, value: unknown): unknown {
  return strippedTo(withoutSecrets(schema), schema, value);
}

function strippedTo(plain: JsonSchema, full: JsonSchema, value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = plain["items"];
    const fullItems = full["items"];
    return isRecord(items) && isRecord(fullItems)
      ? value.map((item: unknown) => strippedTo(items, fullItems, item))
      : value;
  }
  if (!isRecord(value)) {
    return containsSecret(full) ? undefined : value;
  }
  const kept = new Map(propertiesOf(plain));
  const declared = new Map(propertiesOf(full));
  const elsewhere = containsSecret(
    Object.fromEntries(Object.entries(full).filter(([keyword]) => keyword !== "properties")),
  );
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inner]): [string, unknown][] => {
      const property = kept.get(key);
      const fullProperty = declared.get(key);
      if (property !== undefined && fullProperty !== undefined) {
        return [[key, strippedTo(property, fullProperty, inner)]];
      }
      return fullProperty !== undefined || elsewhere ? [] : [[key, inner]];
    }),
  );
}
