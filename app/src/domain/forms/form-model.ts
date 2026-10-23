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
import {
  conditionHolds,
  isAdvanced,
  isUnique,
  isMultiline,
  isReadOnly,
  pathKind,
  reloadOptions,
  shownWhen,
  writtenBy,
  type ReloadOptions,
  type ShownWhen,
} from "./reload-keyword";
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
  /**
   * A secret no credential can hold: a column of a table's rows, or a list of secrets. Drawn
   * so it can be typed, never kept: a value typed is refused, as the old secret store refused it.
   */
  | "unkept"
  /** A text of several lines (`reload.multiline`). */
  | "textarea"
  /** A file or folder's path, typed or chosen with Browse… (`reload.path`). */
  | "path"
  /** An array of distinct options (`items.enum`, `uniqueItems`): each option ticked or not. */
  | "multiselect"
  /** An array of single values: one control per element, added and removed. */
  | "list"
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
  /** A select's options, or a multiselect's, in the schema's order. */
  readonly options?: readonly unknown[];
  /** A number's `minimum`, `maximum` and `multipleOf`, for its input to carry. */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** What a path's Browse… chooses. */
  readonly pathKind?: "file" | "folder";
  /** A list's element: the control each of its values is drawn with. */
  readonly element?: Field;
  /** `readOnly` (JSON Schema): shown, never typed over; a save keeps the value it had. */
  readonly readOnly?: true;
  /**
   * Where a text field's options come from, when its property declares them through `reload`
   * (spec 2.4.1); resolving them is the options route's job. The value stays a plain string.
   */
  readonly reload?: ReloadOptions;
  /** `reload.advanced` (spec 2.4.1): drawn under Advanced, closed as the form opens. */
  readonly advanced?: true;
  /** `reload.writtenBy` (spec 4.6): who besides the person sets it; "plugin" is read-only. */
  readonly writtenBy?: "plugin" | "both";
  /** `reload.shown`: drawn only while a sibling holds a value; its own value is kept hidden. */
  readonly shown?: ShownWhen;
  /** A group's fields, or a table's columns. */
  readonly fields?: readonly Field[];
  /** What a table calls one of its rows (its row's `title`): "Add recorder", "recorder 2". */
  readonly rowLabel?: string;
  /** `reload.unique` on a table's column: no two rows may hold the same value in it. */
  readonly unique?: true;
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

/** An array's items schema, when it declares one. */
function itemsOf(property: JsonSchema): JsonSchema | null {
  const items = property["items"];
  return isRecord(items) ? items : null;
}

/** An array of secrets, through any depth of nested arrays ("a keyring": lists of secrets). */
export function isSecretList(property: JsonSchema): boolean {
  const items = itemsOf(property);
  return typeOf(property) === "array" && items !== null && (isSecret(items) || isSecretList(items));
}

function controlOf(property: JsonSchema, inRow: boolean): Control {
  if (isSecret(property)) {
    return inRow ? "unkept" : "password";
  }
  if (isSecretList(property)) {
    return "unkept";
  }
  if (Array.isArray(property["enum"])) {
    return "select";
  }
  if (reloadOptions(property) === null && pathKind(property) !== null) {
    return "path";
  }
  if (reloadOptions(property) === null && isMultiline(property)) {
    return "textarea";
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
      return arrayControlOf(property);
    default:
      return "text";
  }
}

/**
 * An array of objects is a table, of options a multiselect, of anything else a list, each
 * element drawn with its own control. With no items, or as a list of tables, it is typed as
 * text, and the validator says what is wrong.
 */
function arrayControlOf(property: JsonSchema): Control {
  if (rowSchemaOf(property) !== null) {
    return "table";
  }
  const items = itemsOf(property);
  if (items === null || rowSchemaOf(items) !== null) {
    return "text";
  }
  // A list of options with repeats and an order of its own is a list of selects (the old
  // "list of choice"); distinct options are ticked (the old "multiple-choice").
  return Array.isArray(items["enum"]) && property["uniqueItems"] === true ? "multiselect" : "list";
}

const numberAt = (property: JsonSchema, key: string): number | undefined => {
  const value = property[key];
  return typeof value === "number" ? value : undefined;
};

function fieldOf(key: string, property: JsonSchema, required: boolean, inRow = false): Field {
  const control = controlOf(property, inRow);
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
  if (control === "multiselect") {
    field.options = (itemsOf(property) as JsonSchema)["enum"] as readonly unknown[];
  }
  if (control === "list") {
    field.element = fieldOf(key, itemsOf(property) as JsonSchema, false, inRow);
  }
  if (isReadOnly(property)) {
    field.readOnly = true;
  }
  if (control === "number" || control === "integer") {
    const bounds = { min: "minimum", max: "maximum", step: "multipleOf" } as const;
    for (const [name, keyword] of Object.entries(bounds) as [keyof typeof bounds, string][]) {
      const value = numberAt(property, keyword);
      if (value !== undefined) {
        field[name] = value;
      }
    }
  }
  const kind = control === "path" ? pathKind(property) : null;
  if (kind !== null) {
    field.pathKind = kind;
  }
  const reload = control === "text" ? reloadOptions(property) : null;
  if (reload !== null) {
    field.reload = reload;
  }
  if (isAdvanced(property)) {
    field.advanced = true;
  }
  const writer = writtenBy(property);
  if (writer !== null) {
    field.writtenBy = writer;
  }
  const shown = shownWhen(property);
  if (shown !== null) {
    field.shown = shown;
  }
  if (control === "group") {
    field.fields = formModel(property, inRow).fields;
  }
  if (control === "table") {
    const row = rowSchemaOf(property) as JsonSchema;
    field.fields = formModel(row, true).fields;
    if (typeof row["title"] === "string" && row["title"] !== "") {
      field.rowLabel = row["title"];
    }
  }
  if (isUnique(property)) {
    field.unique = true;
  }
  return field;
}

/**
 * The form for an object schema: one field per property, required ones marked. `inRow`: the
 * object is (inside) a table's row, where a secret can be no credential.
 */
export function formModel(schema: JsonSchema, inRow = false): FormModel {
  const required = requiredOf(schema);
  return {
    fields: propertiesOf(schema).map(([key, property]) =>
      fieldOf(key, property, required.has(key), inRow),
    ),
  };
}

/**
 * A drawn value as the type of its field, for a condition to compare: a form hands back a
 * number, a choice or a switch as text. Unset ("" or nothing) is the field's default.
 */
function typedOf(field: Field, value: unknown): unknown {
  if (value === undefined || value === "") {
    return field.default;
  }
  switch (field.control) {
    case "checkbox":
      return value === true || value === "true";
    case "number":
    case "integer":
      return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
        ? Number(value)
        : value;
    case "select":
      return typeof value === "string"
        ? ((field.options ?? []).find((option) => String(option) === value) ?? value)
        : value;
    default:
      return value;
  }
}

/**
 * The keys of `fields` not drawn for `values` (one object's: the form's top, a group, or one
 * row): each whose `reload.shown` condition its sibling's value does not meet. The condition
 * is judged over the whole object at once, so it may name a field declared after it.
 */
export function hiddenKeys(
  fields: readonly Field[],
  values: Readonly<Record<string, unknown>>,
): Set<string> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return new Set(
    fields
      .filter((field) => {
        if (field.shown === undefined) {
          return false;
        }
        const sibling = byKey.get(field.shown.when);
        const value = sibling === undefined ? undefined : typedOf(sibling, values[sibling.key]);
        return !conditionHolds(field.shown, value);
      })
      .map((field) => field.key),
  );
}

// The refusal in the person's words lives in problems.ts; it is part of reading a form.
export { describedProblems } from "./problems";

/**
 * The same schema without its secret properties, at every depth: in nested objects, in a table's
 * rows, and a list of secrets: what `config` holds (spec 2.5.2). None of them reaches the plain
 * flows or the node's config.
 */
export function withoutSecrets(schema: JsonSchema, root: JsonSchema = schema): JsonSchema {
  const kept = propertiesOf(schema)
    .filter(([, property]) => !isSecret(property))
    .flatMap(([key, property]): [string, JsonSchema][] => {
      const items = itemsOf(property);
      let plain = property;
      if (typeOf(property) === "object") {
        plain = withoutSecrets(property, root);
      } else if (typeOf(property) === "array" && items !== null && !isSecretList(property)) {
        const rows = typeOf(items) === "object" ? withoutSecrets(items, root) : items;
        plain = { ...property, items: rows };
      }
      // A secret left anywhere in it, in a shape the form cannot strip, keeps the whole field
      // out of the plain node properties (the declaration refuses such shapes; this is the net).
      return containsSecret(plain, root) ? [] : [[key, plain]];
    });
  const keys = new Set(kept.map(([key]) => key));
  const result: Record<string, unknown> = { ...schema, properties: Object.fromEntries(kept) };
  if (Array.isArray(schema["required"])) {
    result["required"] = schema["required"].filter(
      (key) => typeof key === "string" && keys.has(key),
    );
  }
  return result;
}

/** Whether a secret is declared anywhere in `schema`, in any keyword, at any depth. */
export function containsSecret(
  schema: unknown,
  root: unknown = schema,
  seen: Set<unknown> = new Set(),
): boolean {
  if (seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  if (Array.isArray(schema)) {
    return schema.some((each) => containsSecret(each, root, seen));
  }
  if (!isRecord(schema)) {
    return false;
  }
  // A `$ref` into the same config is followed: what it names is part of this field.
  const ref = schema["$ref"];
  const named = typeof ref === "string" ? atPointer(root, ref) : undefined;
  return (
    isSecret(schema) ||
    (named !== undefined && containsSecret(named, root, seen)) ||
    Object.values(schema).some((inner) => containsSecret(inner, root, seen))
  );
}

/** The subschema a local `$ref` ("#/$defs/token") names in `root`; undefined for any other. */
function atPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) {
    return undefined;
  }
  let at: unknown = root;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    at = isRecord(at) ? at[segment] : Array.isArray(at) ? at[Number(segment)] : undefined;
  }
  return at;
}

/**
 * Every secret property with its credential's name (spec 2.5.2): its key at the top, its path
 * through the nested objects that hold it below ("account.token"), in declaration order.
 */
export function secretsOf(schema: JsonSchema, prefix = ""): [string, JsonSchema][] {
  return propertiesOf(schema).flatMap(([key, property]): [string, JsonSchema][] => {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    if (isSecret(property)) {
      return [[name, property]];
    }
    return typeOf(property) === "object" ? secretsOf(property, name) : [];
  });
}

/** The names of the secret properties: the type's Node-RED credentials (spec 2.5.2). */
export function secretKeys(schema: JsonSchema): string[] {
  return secretsOf(schema).map(([name]) => name);
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
