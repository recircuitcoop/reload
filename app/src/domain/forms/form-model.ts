// A type's configuration form, drawn from its `config` JSON Schema (spec 2.5, arch_pivot P1).
//
// The old app declared settings in its own vocabulary (addons/settings.py: nine field types,
// tables with row declarations) and drew its own form. A node package declares JSON Schema
// instead, and this is the one reading of it: which control each property gets, its label,
// tip and default, whether it is required, and, for an object or an array of objects, the
// controls inside it. The Node-RED editor (adapters/nodered/editor-forms.ts) draws from it,
// and from `dynamicSelect` for a property whose options come from Anytype (plan 0022 §B).
//
// Pure: no I/O, no DOM, no library.

import type { JsonSchema } from "../packages/declaration";
import { isAdvanced, reloadOptions, type ReloadOptions } from "./reload-keyword";
import {
  READING_SPACES,
  READING_TYPES,
  type NodeOption,
  type OptionsAnswer,
  type OptionsQuery,
} from "./node-options";

export type Control =
  | "text"
  | "number"
  | "integer"
  | "checkbox"
  | "select"
  | "password"
  /** A nested object: its own fields, drawn as a group. */
  | "group"
  /** An array of objects: rows of its fields (plan 0005's table), added, removed, reordered. */
  | "table";

export interface Field {
  /** The property name, the key its value is saved under. */
  readonly key: string;
  readonly control: Control;
  /** `title`, else the key. */
  readonly label: string;
  /** `description`, when there is one. */
  readonly help: string | null;
  /** Named in the enclosing object's `required`. */
  readonly required: boolean;
  /** `default`, when there is one. */
  readonly default?: unknown;
  /** A select's options, in the schema's order. */
  readonly options?: readonly unknown[];
  /**
   * Where a text field's options come from, when its property declares them through `reload`
   * (spec 2.4.1); resolving them is the options route's job. The value stays a plain string.
   */
  readonly reload?: ReloadOptions;
  /** `reload.advanced` (spec 2.4.1): drawn under Advanced, closed as the form opens. */
  readonly advanced?: true;
  /** A group's fields, or a table's columns. */
  readonly fields?: readonly Field[];
}

/**
 * docs/ux/ux-writing.md, "A step's form": the disclosure that holds the advanced fields. Only
 * the canvas draws it (Setup never shows an advanced field), so it is not in ui/strings.ts.
 */
export const ADVANCED_LABEL = "Advanced";

export interface FormModel {
  /** The fields, in the order the schema declares its properties. */
  readonly fields: readonly Field[];
}

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A credential (spec 2.4, 2.5): `writeOnly: true` or `x-secret: true`. */
export function isSecret(property: JsonSchema): boolean {
  return property["writeOnly"] === true || property["x-secret"] === true;
}

/** The object schema's properties, in declaration order; none when it declares none. */
export function propertiesOf(schema: JsonSchema): [string, JsonSchema][] {
  const properties = schema["properties"];
  if (!isRecord(properties)) {
    return [];
  }
  return Object.entries(properties).filter((entry): entry is [string, JsonSchema] =>
    isRecord(entry[1]),
  );
}

function requiredOf(schema: JsonSchema): ReadonlySet<string> {
  const required = schema["required"];
  return new Set(Array.isArray(required) ? required.filter((k) => typeof k === "string") : []);
}

/** The single type a property declares; a list of types or none gives null. */
function typeOf(property: JsonSchema): string | null {
  const type = property["type"];
  return typeof type === "string" ? type : null;
}

/** The object schema an array's items declare, or null when they are not objects. */
export function rowSchemaOf(property: JsonSchema): JsonSchema | null {
  const items = property["items"];
  return isRecord(items) && typeOf(items) === "object" ? items : null;
}

function controlOf(property: JsonSchema): Control {
  if (isSecret(property)) {
    return "password";
  }
  if (Array.isArray(property["enum"])) {
    return "select";
  }
  switch (typeOf(property)) {
    case "boolean":
      return "checkbox";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "object":
      return "group";
    case "array":
      // Only an array of objects is a table; anything else is typed as text, and the
      // validator says what is wrong with it.
      return rowSchemaOf(property) === null ? "text" : "table";
    default:
      return "text";
  }
}

function fieldOf(key: string, property: JsonSchema, required: boolean): Field {
  const control = controlOf(property);
  const title = property["title"];
  const description = property["description"];
  const field: {
    -readonly [K in keyof Field]: Field[K];
  } = {
    key,
    control,
    label: typeof title === "string" && title !== "" ? title : key,
    help: typeof description === "string" && description !== "" ? description : null,
    required,
  };
  if ("default" in property) {
    field.default = property["default"];
  }
  if (control === "select") {
    field.options = property["enum"] as readonly unknown[];
  }
  const reload = control === "text" ? reloadOptions(property) : null;
  if (reload !== null) {
    field.reload = reload;
  }
  if (isAdvanced(property)) {
    field.advanced = true;
  }
  if (control === "group") {
    field.fields = formModel(property).fields;
  }
  if (control === "table") {
    field.fields = formModel(rowSchemaOf(property) as JsonSchema).fields;
  }
  return field;
}

/** The form for an object schema: one field per property, required ones marked. */
export function formModel(schema: JsonSchema): FormModel {
  const required = requiredOf(schema);
  return {
    fields: propertiesOf(schema).map(([key, property]) =>
      fieldOf(key, property, required.has(key)),
    ),
  };
}

// ── a refusal in the person's words ──────────────────────────────────────────────────────

/** The property schema at a JSON Pointer of property names ("/retry/attempts"); null past it. */
function propertyAt(schema: JsonSchema, path: string): JsonSchema | null {
  let at: JsonSchema | null = schema;
  for (const segment of path.split("/").slice(1)) {
    const properties: unknown = at?.["properties"];
    const next: unknown = isRecord(properties) ? properties[segment] : undefined;
    at = isRecord(next) ? next : null;
  }
  return at;
}

/** A property's name as the person reads it: its title exactly as written, else its key spaced. */
function nameAt(schema: JsonSchema, path: string): string {
  const title = propertyAt(schema, path)?.["title"];
  if (typeof title === "string" && title !== "") {
    return title;
  }
  return (path.split("/").at(-1) ?? "").replaceAll("_", " ");
}

/** A value's JSON Schema type in plain words. */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  integer: "a whole number",
  number: "a number",
  string: "text",
  boolean: "on or off",
  object: "a group of values",
  array: "a list",
  null: "empty",
};

/** A string `format` (ajv-formats' names) in plain words. */
const FORMAT_WORDS: Readonly<Record<string, string>> = {
  uri: "a web address",
  "uri-reference": "a web address",
  iri: "a web address",
  "iri-reference": "a web address",
  "uri-template": "a web address",
  url: "a web address",
  email: "an email address",
  "idn-email": "an email address",
  hostname: "a computer's name",
  "idn-hostname": "a computer's name",
  ipv4: "an IP address",
  ipv6: "an IP address",
  date: "a date",
  time: "a time of day",
  "date-time": "a date and time",
  "iso-time": "a time of day",
  "iso-date-time": "a date and time",
  duration: "a length of time",
  uuid: "an ID",
  regex: "a search pattern",
  "json-pointer": "a path",
  "relative-json-pointer": "a path",
  byte: "encoded data",
  int32: "a whole number",
  int64: "a whole number",
  float: "a number",
  double: "a number",
  password: "text",
  binary: "data",
};

/**
 * What ajv says is wrong (minimum, maximum, exclusive bounds, minLength, maxLength, pattern,
 * format, type, enum, const), plainly; anything else as ajv words it.
 */
function plainMessage(message: string): string {
  const words: [RegExp, (found: string) => string][] = [
    [/^must be <= (.+)$/, (n) => `must be ${n} or less`],
    [/^must be >= (.+)$/, (n) => `must be ${n} or more`],
    [/^must be < (.+)$/, (n) => `must be less than ${n}`],
    [/^must be > (.+)$/, (n) => `must be more than ${n}`],
    [
      /^must NOT have fewer than (\d+) characters?$/,
      (n) => (n === "1" ? "must not be empty" : `must be at least ${n} characters long`),
    ],
    [/^must NOT have more than (\d+) characters?$/, (n) => `must be at most ${n} characters long`],
    [/^must match pattern .*$/, () => "is not in the form it must have"],
    [
      /^must match format "(.+)"$/,
      (format) => {
        const kind = FORMAT_WORDS[format];
        return kind === undefined ? "is not in the form it must have" : `must be ${kind}`;
      },
    ],
    [/^must be equal to one of the allowed values$/, () => "must be one of its choices"],
    [/^must be equal to constant$/, () => "must be the one value it allows"],
    [/^must be (\w+)$/, (type) => `must be ${TYPE_WORDS[type] ?? type}`],
  ];
  for (const [pattern, said] of words) {
    const found = pattern.exec(message);
    if (found !== null) {
      return said(found[1] ?? "");
    }
  }
  return message;
}

/**
 * One problem as "<Title>: <what to do>.", against `schema`, the object its path starts in. The
 * title stands as a label, exactly as written, never inside a sentence; a table's row is
 * "<table title>, row N, <column title>: …".
 */
function describedProblem(schema: JsonSchema, path: string, message: string): string {
  if (path === "") {
    return `The form: ${plainMessage(message)}.`;
  }
  const segments = path.split("/").slice(1);
  const row = segments.findIndex((segment) => /^\d+$/.test(segment));
  if (row > 0) {
    const table = `/${segments.slice(0, row).join("/")}`;
    const rest = segments.slice(row + 1);
    const where = `${nameAt(schema, table)}, row ${String(Number(segments[row]) + 1)}`;
    if (rest.length === 0) {
      return `${where}: ${plainMessage(message)}.`;
    }
    const rows = rowSchemaOf(propertyAt(schema, table) ?? {}) ?? {};
    return `${where}, ${describedProblem(rows, `/${rest.join("/")}`, message)}`;
  }
  const name = nameAt(schema, path);
  if (message !== "is required") {
    return `${name}: ${plainMessage(message)}.`;
  }
  const property = propertyAt(schema, path) ?? {};
  const chosen = reloadOptions(property) !== null || Array.isArray(property["enum"]);
  return `${name}: ${chosen ? "choose one" : "fill this in"}.`;
}

/**
 * What a step lacks, in the person's words, for "*Step* isn't set up yet. …": each field by its
 * label and what to do ("Space: choose one.", "Name from: fill this in.", "At most: must be 100
 * or less.", "Properties, row 2, Value from: fill this in."). Never a schema key (ux-writing,
 * Voice).
 */
export function describedProblems(
  schema: JsonSchema,
  problems: readonly { readonly path: string; readonly message: string }[],
): string {
  return problems.map(({ path, message }) => describedProblem(schema, path, message)).join(" ");
}

/** The same schema without its secret properties: what `config` holds (spec 2.5.2). */
export function withoutSecrets(schema: JsonSchema): JsonSchema {
  const kept = propertiesOf(schema).filter(([, property]) => !isSecret(property));
  const keys = new Set(kept.map(([key]) => key));
  const result: Record<string, unknown> = { ...schema, properties: Object.fromEntries(kept) };
  if (Array.isArray(schema["required"])) {
    result["required"] = schema["required"].filter(
      (key) => typeof key === "string" && keys.has(key),
    );
  }
  return result;
}

/** The names of the secret properties: the type's Node-RED credentials (spec 2.5.2). */
export function secretKeys(schema: JsonSchema): string[] {
  return propertiesOf(schema)
    .filter(([, property]) => isSecret(property))
    .map(([key]) => key);
}

// ── rows of a table ──────────────────────────────────────────────────────────────────────

type Row = Readonly<Record<string, unknown>>;

/** A new row: each column's default, where it has one. */
export function newRow(columns: readonly Field[]): Row {
  return Object.fromEntries(
    columns.filter((column) => "default" in column).map((column) => [column.key, column.default]),
  );
}

/** The rows with a new row appended. */
export function addRow(rows: readonly Row[], columns: readonly Field[]): Row[] {
  return [...rows, newRow(columns)];
}

/** The rows without the one at `index`; an index outside them changes nothing. */
export function removeRow(rows: readonly Row[], index: number): Row[] {
  return rows.filter((_, at) => at !== index);
}

/** The rows with the one at `from` moved to `to`; an index outside them changes nothing. */
export function moveRow(rows: readonly Row[], from: number, to: number): Row[] {
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) {
    return [...rows];
  }
  const moved = [...rows];
  const [row] = moved.splice(from, 1);
  moved.splice(to, 0, row as Row);
  return moved;
}

// ── dynamic options (plan 0022 §B, D9) ───────────────────────────────────────────────────

/**
 * What a field with `reload` options asks for, given the values its siblings hold now: the
 * spaces, or the types of the space its `of` sibling holds. Null when it asks nothing: a field
 * with no `reload`, or a types field whose space is not chosen yet.
 */
export function optionsQueryOf(
  field: Field,
  siblings: Readonly<Record<string, unknown>>,
): OptionsQuery | null {
  const reload = field.reload;
  if (reload === undefined) {
    return null;
  }
  if (reload.source === "spaces") {
    return { source: "spaces" };
  }
  const spaceId = siblings[reload.of];
  return typeof spaceId === "string" && spaceId !== "" ? { source: "types", spaceId } : null;
}

/** Where a dynamic select is: no space chosen yet, reading, or answered. */
export type OptionsState =
  | { readonly kind: "waiting" }
  | { readonly kind: "loading" }
  | { readonly kind: "answered"; readonly answer: OptionsAnswer };

/** A dynamic select as drawn: its choices, the one chosen, whether usable, and a sentence. */
export interface DynamicSelect {
  /** The empty choice first, then the options; the stored value too when they lack it. */
  readonly options: readonly NodeOption[];
  readonly value: string;
  readonly disabled: boolean;
  /** "Reading your spaces…", or a refusal's sentence, shown in place of the options. */
  readonly sentence: string | null;
}

const EMPTY_CHOICE: NodeOption = { value: "", label: "" };

/**
 * The select of `field` (an `reload` field) holding `value`, in `state`. The value stays a
 * plain string and is never dropped silently: while reading, when refused, and when the
 * answer lacks it, it is offered under its own text, so saving keeps it. The one exception is
 * `keepUnlisted: false`, after the person chose another space: a type that space lacks is
 * cleared rather than carried over. A types field with no space is empty and disabled.
 */
export function dynamicSelect(
  field: Field,
  value: string,
  state: OptionsState,
  keepUnlisted = true,
): DynamicSelect {
  const stored = value === "" ? [] : [{ value, label: value }];
  switch (state.kind) {
    case "waiting":
      return { options: [EMPTY_CHOICE], value: "", disabled: true, sentence: null };
    case "loading": {
      const sentence = field.reload?.source === "types" ? READING_TYPES : READING_SPACES;
      return { options: [EMPTY_CHOICE, ...stored], value, disabled: true, sentence };
    }
    case "answered": {
      const { answer } = state;
      if ("refused" in answer) {
        const sentence = answer.refused.sentence;
        return { options: [EMPTY_CHOICE, ...stored], value, disabled: true, sentence };
      }
      const listed = answer.options.some((option) => option.value === value);
      if (listed || value === "") {
        return {
          options: [EMPTY_CHOICE, ...answer.options],
          value,
          disabled: false,
          sentence: null,
        };
      }
      return keepUnlisted
        ? {
            options: [EMPTY_CHOICE, ...answer.options, ...stored],
            value,
            disabled: false,
            sentence: null,
          }
        : {
            options: [EMPTY_CHOICE, ...answer.options],
            value: "",
            disabled: false,
            sentence: null,
          };
    }
  }
}
