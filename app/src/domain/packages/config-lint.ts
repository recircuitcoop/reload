// A type's `config` schema judged as the form will draw it, when its package is read (plan 0032,
// group 26): at install, at load, and by reload-pack, so an author learns of a mistake before a
// person meets it, and never believes a rule is in force that is not.
//
// The old manifest refused a broken settings declaration naming the field (tests/
// test_addon_settings.py, test_table_declaration.py): a default of the wrong type or outside its
// bounds, an empty or repeated list of options, a minimum above its maximum, an unknown or
// misplaced attribute, a field without a label, a table without columns or a row noun, a list of
// lists, and a typo three levels down, by its whole path. JSON Schema states most of a field's
// shape itself; this adds what a valid JSON Schema can still get wrong for a form, and judges
// every default by its own schema. The meta-schema and the value checks are a real validator's
// (`ConfigJudge`, ajv in adapters/schema).
//
// Pure: no I/O, no library.

import type { FieldProblem, JsonSchema } from "./declaration";

/** The validator this needs: the JSON Schema meta-schema, and a value against a schema. */
export interface ConfigJudge {
  /** What is wrong with `schema` as a JSON Schema 2020-12; paths are pointers into it. */
  meta(schema: JsonSchema): readonly FieldProblem[];
  /** What is wrong with `value` by `schema`; paths are pointers into the value. */
  check(schema: JsonSchema, value: unknown): readonly FieldProblem[];
}

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every JSON Schema 2020-12 keyword, the two older ones the form reads, and Reload's two. */
const KNOWN = new Set([
  "$schema",
  "$id",
  "$ref",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
  "dependencies",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "prefixItems",
  "items",
  "contains",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "x-secret",
  "reload",
]);

/** The keywords that judge only one kind of value, and the types they apply to. */
const APPLIES: readonly [readonly string[], readonly string[]][] = [
  [
    ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    ["number", "integer"],
  ],
  [
    ["minLength", "maxLength", "pattern", "contentEncoding", "contentMediaType", "contentSchema"],
    ["string"],
  ],
  [
    [
      "items",
      "prefixItems",
      "minItems",
      "maxItems",
      "uniqueItems",
      "contains",
      "minContains",
      "maxContains",
      "unevaluatedItems",
    ],
    ["array"],
  ],
  [
    [
      "properties",
      "required",
      "additionalProperties",
      "patternProperties",
      "minProperties",
      "maxProperties",
      "propertyNames",
      "dependentRequired",
      "dependentSchemas",
      "unevaluatedProperties",
    ],
    ["object"],
  ],
];

/** Pairs of a lower and an upper bound that a schema may not cross. */
const BOUNDS: readonly [string, string][] = [
  ["minimum", "maximum"],
  ["exclusiveMinimum", "maximum"],
  ["minimum", "exclusiveMaximum"],
  ["exclusiveMinimum", "exclusiveMaximum"],
  ["minLength", "maxLength"],
  ["minItems", "maxItems"],
  ["minProperties", "maxProperties"],
  ["minContains", "maxContains"],
];

/** Keywords that say what a property's values are; a property with none of them says nothing. */
const TYPING = ["type", "enum", "const", "$ref", "anyOf", "oneOf", "allOf"];

/** A pointer segment, escaped (RFC 6901). */
const segment = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");

const typeOf = (schema: JsonSchema): string | null =>
  typeof schema["type"] === "string" ? schema["type"] : null;

const annotationOf = (schema: JsonSchema): JsonSchema =>
  isRecord(schema["reload"]) ? schema["reload"] : {};

const isSecret = (schema: JsonSchema): boolean =>
  schema["writeOnly"] === true || schema["x-secret"] === true;

/** An array of secrets, through any depth of nested arrays. */
const secretList = (schema: JsonSchema): boolean => {
  const items = schema["items"];
  return typeOf(schema) === "array" && isRecord(items) && (isSecret(items) || secretList(items));
};

/** A table's row: an array's items that are an object. */
const rowOf = (schema: JsonSchema): JsonSchema | null => {
  const items = schema["items"];
  return typeOf(schema) === "array" && isRecord(items) && typeOf(items) === "object" ? items : null;
};

const propertiesOf = (schema: JsonSchema): [string, unknown][] =>
  isRecord(schema["properties"]) ? Object.entries(schema["properties"]) : [];

/**
 * Everything wrong with `config` for the form, each named by its pointer under `at`
 * ("/types/0/config"). A schema the meta-schema refuses is reported alone: the rest is judged
 * only on a schema that is one.
 */
export function configProblems(config: JsonSchema, at: string, judge: ConfigJudge): FieldProblem[] {
  const meta = judge.meta(config);
  if (meta.length > 0) {
    return meta.map((problem) => ({ path: `${at}${problem.path}`, message: problem.message }));
  }
  const problems: FieldProblem[] = [];
  const say = (path: string, message: string): void => {
    problems.push({ path: `${at}${path}`, message });
  };
  node(config, "", { root: config, judge, say, row: null });
  return problems;
}

interface Context {
  readonly root: JsonSchema;
  readonly judge: ConfigJudge;
  readonly say: (path: string, message: string) => void;
  /** The row whose columns are being judged; null outside a table's rows. */
  readonly row: JsonSchema | null;
}

/** One drawn schema: the config itself, a property, or an array's items. */
function node(schema: JsonSchema, path: string, context: Context): void {
  const { say } = context;
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) {
      say(`${path}/${segment(key)}`, "is not a JSON Schema keyword the form knows");
    }
  }
  if (path !== "" && !TYPING.some((keyword) => keyword in schema)) {
    say(path, "declares no type, so the form cannot draw it: give it a type");
  }
  misplaced(schema, path, say);
  for (const [low, high] of BOUNDS) {
    const lower = schema[low];
    const upper = schema[high];
    if (typeof lower === "number" && typeof upper === "number" && lower > upper) {
      say(`${path}/${low}`, `${String(lower)} is above ${high} ${String(upper)}`);
    }
  }
  options(schema, path, context);
  if ("default" in schema) {
    defaults(schema, path, context);
  }
  arrayShape(schema, path, context);
  if (path === "" || typeOf(schema) === "object") {
    properties(schema, path, context);
  }
  const items = schema["items"];
  if (typeOf(schema) === "array" && isRecord(items)) {
    node(items, `${path}/items`, { ...context, row: rowOf(schema) });
  }
}

/** A keyword that judges another type than the one the schema declares never applies. */
function misplaced(schema: JsonSchema, path: string, say: Context["say"]): void {
  const type = typeOf(schema);
  if (type !== null) {
    for (const [keywords, types] of APPLIES) {
      for (const keyword of keywords.filter((each) => each in schema)) {
        if (!types.includes(type)) {
          say(`${path}/${keyword}`, `applies to ${types.join(" or ")} only, not to ${type}`);
        }
      }
    }
  }
  const annotation = annotationOf(schema);
  for (const key of ["multiline", "path"]) {
    if (key in annotation && Array.isArray(schema["enum"])) {
      say(`${path}/reload/${key}`, "is never drawn on a list of options (enum)");
    }
  }
}

/** A list of options: at least one, each once, never empty text, each of the schema's type. */
function options(schema: JsonSchema, path: string, context: Context): void {
  const choices = schema["enum"];
  if (!Array.isArray(choices)) {
    return;
  }
  if (choices.length === 0) {
    context.say(`${path}/enum`, "offers no options: list at least one");
  }
  const seen = new Set<string>();
  choices.forEach((choice: unknown, index) => {
    const text = JSON.stringify(choice);
    if (seen.has(text)) {
      context.say(`${path}/enum/${String(index)}`, `${text} is offered twice`);
    }
    seen.add(text);
    if (choice === "") {
      context.say(`${path}/enum/${String(index)}`, "an empty option cannot be told from no choice");
    }
  });
  // Each option judged by the rest of the property's own schema.
  const rest = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "enum" && key !== "default"),
  );
  if (!valuesJudged(rest)) {
    return;
  }
  choices.forEach((choice: unknown, index) => {
    if (context.judge.check(withDefs(rest, context.root), choice).length > 0) {
      context.say(
        `${path}/enum/${String(index)}`,
        `${JSON.stringify(choice)} does not fit the property's own type`,
      );
    }
  });
}

/** Whether a value can be judged by `schema` alone: it refers to nothing but the config's $defs. */
const valuesJudged = (schema: JsonSchema): boolean =>
  !JSON.stringify(schema).includes('"$ref":"#"');

/** The schema with the config's $defs beside it, so a reference into them resolves. */
function withDefs(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const defs = Object.fromEntries(
    ["$defs", "definitions"].filter((key) => key in root).map((key) => [key, root[key]]),
  );
  return { ...defs, ...schema };
}

/**
 * A default is a value, judged like any other value by its own schema (with each column's own
 * default filled in, as a new row gets it): a default the person could not save is the author's
 * mistake. A table's default holds whole rows, at least one, each with only declared columns.
 */
function defaults(schema: JsonSchema, path: string, context: Context): void {
  const value = schema["default"];
  const at = `${path}/default`;
  if (rowOf(schema) !== null && Array.isArray(value) && value.length === 0) {
    context.say(at, "a table that starts with no rows needs no default: leave it out");
    return;
  }
  for (const undeclared of undeclaredIn(schema, value, [])) {
    context.say(at, `${named(schema, undeclared)} is not a declared property`);
  }
  if (!valuesJudged(schema)) {
    return;
  }
  const filled = withColumnDefaults(schema, value);
  for (const problem of context.judge.check(withDefs(schema, context.root), filled)) {
    const pointer = problem.path.split("/").slice(1).map(unescape);
    const found = valueAt(filled, pointer);
    const shown = problem.message.startsWith("must be one of")
      ? `, not ${JSON.stringify(found)}`
      : "";
    context.say(at, `${named(schema, pointer)} ${problem.message}${shown}`);
  }
}

const unescape = (raw: string): string => raw.replaceAll("~1", "/").replaceAll("~0", "~");

function valueAt(value: unknown, pointer: readonly string[]): unknown {
  let at = value;
  for (const key of pointer) {
    at = isRecord(at) || Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined;
  }
  return at;
}

/** The value with each property's own default filled in where it is left out, at every depth. */
function withColumnDefaults(schema: JsonSchema, value: unknown): unknown {
  const items = schema["items"];
  if (Array.isArray(value)) {
    return isRecord(items) ? value.map((each: unknown) => withColumnDefaults(items, each)) : value;
  }
  if (!isRecord(value)) {
    return value;
  }
  const filled: Record<string, unknown> = { ...value };
  for (const [key, property] of propertiesOf(schema)) {
    if (!isRecord(property)) {
      continue;
    }
    if (key in filled) {
      filled[key] = withColumnDefaults(property, filled[key]);
    } else if ("default" in property) {
      filled[key] = property["default"];
    }
  }
  return filled;
}

/** The pointers of keys in `value` that `schema` does not declare and does not let in. */
function undeclaredIn(schema: JsonSchema, value: unknown, pointer: string[]): string[][] {
  const items = schema["items"];
  if (Array.isArray(value)) {
    return isRecord(items)
      ? value.flatMap((each: unknown, index) =>
          undeclaredIn(items, each, [...pointer, String(index)]),
        )
      : [];
  }
  const declared = schema["properties"];
  if (!isRecord(value) || !isRecord(declared)) {
    return [];
  }
  const open = "additionalProperties" in schema || "patternProperties" in schema;
  return Object.entries(value).flatMap(([key, inner]) => {
    const property = declared[key];
    if (isRecord(property)) {
      return undeclaredIn(property, inner, [...pointer, key]);
    }
    return open || key in declared ? [] : [[...pointer, key]];
  });
}

/**
 * A place in a default as its author finds it: "default[1]" in a list, "default › Recorder 2 ›
 * language" in a table, each row named by its row's title and its place counted from one.
 */
function named(schema: JsonSchema, pointer: readonly string[]): string {
  let text = "default";
  let at: unknown = schema;
  for (const key of pointer) {
    const here = isRecord(at) ? at : {};
    const items = here["items"];
    if (typeOf(here) === "array" || Array.isArray(items) || isRecord(items)) {
      const row = rowOf(here);
      const noun = row !== null && typeof row["title"] === "string" ? row["title"] : null;
      text += noun === null ? `[${key}]` : ` › ${noun} ${String(Number(key) + 1)}`;
      at = items;
    } else {
      text += ` › ${key}`;
      const properties = here["properties"];
      at = isRecord(properties) ? properties[key] : undefined;
    }
  }
  return text;
}

/**
 * An array the form can draw: it says what its elements are, it is no list of lists (nor of
 * tables), and a table's row has columns and a noun for its Add button ("Add Recorder").
 */
function arrayShape(schema: JsonSchema, path: string, context: Context): void {
  if (typeOf(schema) !== "array") {
    return;
  }
  const items = schema["items"];
  if (!isRecord(items)) {
    context.say(path, "declares no items, so the form cannot draw its elements: give it items");
    return;
  }
  // A list of lists of secrets is one control that keeps nothing (a keyring, form-model.ts).
  if (typeOf(items) === "array" && !secretList(items)) {
    context.say(`${path}/items`, "a list of lists (or of tables) cannot be drawn");
  }
  const row = rowOf(schema);
  if (row === null) {
    return;
  }
  if (propertiesOf(row).length === 0) {
    context.say(`${path}/items`, "a table's row declares no columns: give it properties");
  }
  if (typeof row["title"] !== "string" || row["title"] === "") {
    context.say(`${path}/items/title`, "a table names its row (Add …): give its items a title");
  }
}

/** The properties of an object: each named, labelled, drawn; a row's unique and shown rules. */
function properties(schema: JsonSchema, path: string, context: Context): void {
  const { say } = context;
  const columns = propertiesOf(schema);
  const keys = new Set(columns.map(([key]) => key));
  const unique: string[] = [];
  for (const [key, property] of columns) {
    const at = `${path}/properties/${segment(key)}`;
    if (key === "") {
      say(at, "a property needs a name");
    }
    if (!isRecord(property)) {
      say(at, "must be a schema object, as every drawn property is");
      continue;
    }
    if (typeof property["title"] !== "string" || property["title"] === "") {
      say(`${at}/title`, "is the label the person reads: give the property a title");
    }
    const annotation = annotationOf(property);
    if (annotation["unique"] === true) {
      unique.push(key);
      uniqueColumn(property, at, schema === context.row, say);
    }
    const shown = annotation["shown"];
    if (isRecord(shown) && typeof shown["when"] === "string") {
      const when = shown["when"];
      if (when === key) {
        say(`${at}/reload/shown/when`, `${JSON.stringify(when)} is this property itself`);
      } else if (!keys.has(when)) {
        say(
          `${at}/reload/shown/when`,
          `${JSON.stringify(when)} is not a property beside ${JSON.stringify(key)}: a ` +
            "condition names a property of the same group or row",
        );
      }
    }
    // A table's row is its own: a property in a group of the row is no column of it.
    node(property, at, { ...context, row: schema === context.row ? context.row : null });
  }
  if (unique.length > 1) {
    say(
      `${path}/properties`,
      `${unique.map((key) => JSON.stringify(key)).join(" and ")} are both unique: a row has one`,
    );
  }
}

/** What a type is called in a refusal of `unique`. */
const KINDS: Readonly<Record<string, string>> = {
  string: "several lines of text",
  boolean: "a yes or no",
  array: "a list or a table",
  object: "a group",
};

/** A unique column: in a table's row, of a type whose values a person can tell apart. */
function uniqueColumn(property: JsonSchema, at: string, inRow: boolean, say: Context["say"]): void {
  const where = `${at}/reload/unique`;
  if (!inRow) {
    say(where, "only a column of a table's row can be unique among the rows");
    return;
  }
  const type = typeOf(property);
  const plainText = type === "string" && annotationOf(property)["multiline"] !== true;
  const comparable =
    !isSecret(property) &&
    (plainText || type === "number" || type === "integer" || Array.isArray(property["enum"]));
  if (!comparable) {
    const kind = isSecret(property)
      ? "a secret"
      : (KINDS[String(type)] ?? "a value of no single type");
    say(where, `${kind} cannot tell one row from another: mark a text, number or choice`);
  }
}
