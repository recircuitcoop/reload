// The canvas form judged (editor-forms.ts draws it): a node's values as the runtime coerces and
// judges them (registration.ts), each problem by the path of the field it is about, so the
// reason is said beside its field as the form opens and in Node-RED's validator.
//
// Like editor-forms.ts, this runs in the editor's browser page; its unit test draws in a DOM.

import type { ValidateFunction } from "ajv/dist/2020.js";

import {
  coerceObject,
  declaredOnly,
  emptyRequired,
  forbiddenKeys,
  missingSecrets,
} from "../../domain/forms/coerce";
import { describedProblems, type Field } from "../../domain/forms/form-model";
import { unkeptSecretsOfNode } from "../../domain/forms/unkept";
import type { JsonSchema } from "../../domain/packages/declaration";
import { isRecord } from "./editor-read";

type Values = Record<string, unknown>;

export interface Registered {
  /** The config schema without its secrets: what the node's own properties must satisfy. */
  readonly schema: JsonSchema;
  /** The whole config schema, secrets included. */
  readonly full: JsonSchema;
  readonly fields: readonly Field[];
  readonly validate: ValidateFunction;
}

/** Why a value typed into a secret no credential can hold is not kept (unkept.ts). */
export const UNKEPT = "is a secret no credential can hold, so it is not kept";

/** A problem of the node: the JSON pointer of its field, and what is wrong. */
export interface NodeProblem {
  readonly path: string;
  readonly message: string;
}

/** The node's own values for its declared, non-secret properties, as Node-RED keeps them. */
export function ownOf(entry: Registered, node: Values): Values {
  const plain = entry.fields.filter(
    (field) => field.control !== "password" && field.control !== "unkept",
  );
  return Object.fromEntries(plain.map((field) => [field.key, node[field.key]]));
}

/** The node's values for its declared properties, coerced as the runtime will coerce them. */
function valuesOf(entry: Registered, node: Values): Values {
  // As the runtime judges it: nothing the schema does not declare (coerce.ts configOf).
  return declaredOnly(entry.schema, coerceObject(entry.schema, ownOf(entry, node))) as Values;
}

/** Each ajv error as the field it is about and what is wrong with it. */
export function problems(validate: ValidateFunction): NodeProblem[] {
  return (validate.errors ?? []).map((error) => {
    const params = error.params as Record<string, unknown>;
    const missing = params["missingProperty"];
    return error.keyword === "required" && typeof missing === "string"
      ? { path: `${error.instancePath}/${missing}`, message: "is required" }
      : { path: error.instancePath, message: error.message ?? error.keyword };
  });
}

/**
 * Everything wrong with the node now, as the runtime refuses it: its schema's refusals, a
 * required value left empty, a secret typed where no credential can hold it, and a required
 * secret unset (once Node-RED has said which of the node's secrets are set).
 */
export function nodeProblems(entry: Registered, node: Values): NodeProblem[] {
  const values = valuesOf(entry, node);
  const found = entry.validate(values) ? [] : problems(entry.validate);
  // A key a row does not take, which `valuesOf` left out: said on the row that holds it.
  found.push(...forbiddenKeys(entry.schema, coerceObject(entry.schema, ownOf(entry, node))));
  found.push(...emptyRequired(entry.schema, values));
  for (const path of unkeptSecretsOfNode(entry.full, node)) {
    found.push({ path: `/${path.replaceAll(".", "/")}`, message: UNKEPT });
  }
  const held = node["credentials"];
  if (isRecord(held)) {
    const set = new Set(
      Object.keys(held)
        .filter((name) => name.startsWith("has_") && held[name] === true)
        .map((name) => name.slice("has_".length)),
    );
    // A top-level secret is Node-RED's own input, judged by Node-RED.
    for (const name of missingSecrets(entry.full, values, set).filter((n) => n.includes("."))) {
      found.push({ path: `/${name.replaceAll(".", "/")}`, message: "is required" });
    }
  }
  return found;
}

/**
 * Node-RED's validator for one property: true, or the reason it is refused. Every property
 * is judged against the whole schema, and answers for the errors under its own name; a top
 * secret is Node-RED's own input, judged by Node-RED.
 */
export function judge(entry: Registered, node: Values, key: string): true | string {
  // A refusal of the whole node (a dependentRequired, anyOf, not…) is said at its first field.
  const first = Object.keys(ownOf(entry, {}))[0] === key;
  const mine = nodeProblems(entry, node).filter(
    ({ path }) => path.startsWith(`/${key}/`) || path === `/${key}` || (path === "" && first),
  );
  // In the person's words, by the property's title: never its key.
  return mine.length === 0 ? true : describedProblems(entry.full, mine);
}
