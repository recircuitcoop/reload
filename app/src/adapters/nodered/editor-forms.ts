// The generated types' forms, inside the Node-RED editor (spec 2.5, WI-0018-09).
//
// Bundled on its own for the browser (`npm run build:editor`) and written once into the
// generated folder as reload-forms.html, which Node-RED puts in the editor page with every node
// definition. Each generated type calls `window.ReloadForms` from its oneditprepare, oneditsave
// and property validators. It draws the form model of domain/forms (text, number, integer,
// checkbox, select, nested groups and tables whose rows are added, removed and reordered),
// marks the required fields, and validates the node with ajv before it can be deployed
// cleanly: a node whose values the schema refuses is shown invalid, with the reason.
//
// A string property whose options come from Anytype (`reload.spaces`, `reload.types.of`;
// plan 0022 §B) is a select filled from the admin route /red/reload/options as the form opens:
// "Reading your spaces…", then the names, each storing its plain id or key. A types select reads
// its sibling space and reads again when that changes; with no space it is empty and disabled.
// Not paired, the sentence shows in place of the options, and the stored value stays.
//
// A property marked `reload.advanced` (spec 2.4.1) is drawn as any other, but in a closed
// "Advanced" disclosure after the others; it is read back from there the same way.
//
// Secrets are not drawn here: they are Node-RED credential inputs in the type's own template,
// which Node-RED fills and saves itself, and never hands back to the editor (spec 2.5.2).
//
// This file runs only in the editor's browser page, so no unit test loads it; it is excluded
// from coverage like the preload bridge, and the e2e drives it in the real editor.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import { coerceObject } from "../../domain/forms/coerce";
import { RELOAD_ANNOTATION } from "../../domain/forms/reload-keyword";
import {
  ADVANCED_LABEL,
  addRow,
  describedProblems,
  dynamicSelect,
  formModel,
  moveRow,
  optionsQueryOf,
  removeRow,
  withoutSecrets,
  type DynamicSelect,
  type Field,
  type OptionsState,
} from "../../domain/forms/form-model";
import {
  parseOptionsAnswer,
  refusal,
  type OptionsAnswer,
  type OptionsQuery,
} from "../../domain/forms/node-options";
import type { JsonSchema } from "../../domain/packages/declaration";

type Values = Record<string, unknown>;

interface Registered {
  /** The config schema without its secrets: what the node's own properties must satisfy. */
  readonly schema: JsonSchema;
  readonly fields: readonly Field[];
  readonly validate: ValidateFunction;
}

// `reload` (spec 2.4.1) is a known annotation: it never changes what validates.
const ajv = new Ajv2020({ allErrors: true, strict: false }).addKeyword(RELOAD_ANNOTATION);
const types = new Map<string, Registered>();

function registered(type: string): Registered {
  const found = types.get(type);
  if (found === undefined) {
    throw new Error(`Reload: no form is defined for ${type}`);
  }
  return found;
}

/** A generated type's definition: its full config schema (secrets are left out here). */
function define(type: string, schema: JsonSchema): void {
  const plain = withoutSecrets(schema);
  const fields = formModel(plain).fields;
  types.set(type, { schema: plain, fields, validate: ajv.compile(plain) });
}

/** The node's values for its declared properties, coerced as the runtime will coerce them. */
function valuesOf(entry: Registered, node: Values): Values {
  const own = Object.fromEntries(entry.fields.map((field) => [field.key, node[field.key]]));
  return coerceObject(entry.schema, own);
}

/** Each ajv error as the field it is about and what is wrong with it. */
function problems(validate: ValidateFunction): { path: string; message: string }[] {
  return (validate.errors ?? []).map((error) => {
    const params = error.params as Record<string, unknown>;
    const missing = params["missingProperty"];
    return error.keyword === "required" && typeof missing === "string"
      ? { path: `${error.instancePath}/${missing}`, message: "is required" }
      : { path: error.instancePath, message: error.message ?? error.keyword };
  });
}

/**
 * Node-RED's validator for one property: true, or the reason it is refused. Every property
 * is judged against the whole schema, and answers for the errors under its own name.
 */
function validate(type: string, node: Values, key: string): true | string {
  const entry = registered(type);
  if (entry.validate(valuesOf(entry, node))) {
    return true;
  }
  const mine = problems(entry.validate).filter(
    ({ path }) => path === `/${key}` || path.startsWith(`/${key}/`),
  );
  // In the person's words, by the property's title: never its key.
  return mine.length === 0 ? true : describedProblems(entry.schema, mine);
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    made.setAttribute(name, value);
  }
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

/** A field's label; a required one is marked with an asterisk and a class. */
function labelFor(field: Field, path: string): HTMLLabelElement {
  const label = element("label", { for: `reload-input-${path}` }, field.label);
  if (field.required) {
    label.classList.add("reload-required");
    label.setAttribute("data-testid", "reload-required");
    label.append(element("span", { "aria-hidden": "true" }, " *"));
  }
  return label;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** One scalar control, holding `value`. */
function scalar(field: Field, path: string, value: unknown): HTMLElement {
  const id = `reload-input-${path}`;
  const common = { id, "data-reload-field": path, "data-testid": `reload-field-${path}` };
  if (field.reload !== undefined) {
    // Filled by wireOptions once its row, and its sibling's, are in the form.
    const select = element("select", { ...common, "data-reload-options": field.reload.source });
    select.style.width = "70%";
    showSelect(select, dynamicSelect(field, typeof value === "string" ? value : "", LOADING));
    return select;
  }
  switch (field.control) {
    case "checkbox": {
      const box = element("input", { ...common, type: "checkbox", style: "width:auto" });
      box.checked = value === true || value === "true";
      return box;
    }
    case "select": {
      const select = element("select", { ...common, style: "width:70%" });
      if (!field.required) {
        select.append(element("option", { value: "" }, ""));
      }
      for (const option of field.options ?? []) {
        select.append(element("option", { value: String(option) }, String(option)));
      }
      const option =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      select.value = option ? String(value) : "";
      return select;
    }
    case "number":
    case "integer": {
      const step = field.control === "integer" ? "1" : "any";
      const input = element("input", { ...common, type: "number", step, style: "width:70%" });
      input.value = textOf(value);
      return input;
    }
    default: {
      const input = element("input", { ...common, type: "text", style: "width:70%" });
      input.value = textOf(value);
      return input;
    }
  }
}

/** The controls of `fields`, holding `values`, under `container`; the advanced ones folded. */
function draw(container: HTMLElement, fields: readonly Field[], values: Values, prefix: string) {
  const advanced = element("details", {
    "data-reload-advanced": "",
    "data-testid": `reload-advanced${prefix === "" ? "" : `-${prefix}`}`,
  });
  advanced.append(element("summary", {}, ADVANCED_LABEL));
  for (const field of fields) {
    if (field.control === "password") {
      continue;
    }
    const path = prefix === "" ? field.key : `${prefix}.${field.key}`;
    const value = values[field.key] ?? field.default;
    const row = element("div", { class: "form-row", "data-reload-key": field.key });
    row.append(labelFor(field, path));
    if (field.control === "group") {
      const group = element("fieldset", { "data-reload-group": path });
      draw(group, field.fields ?? [], isRecord(value) ? value : {}, path);
      row.append(group);
    } else if (field.control === "table") {
      row.append(table(field, path, Array.isArray(value) ? (value as Values[]) : []));
    } else {
      row.append(scalar(field, path, value));
    }
    if (field.reload !== undefined) {
      row.append(
        element("div", {
          class: "form-tips reload-options-note",
          "data-reload-note": path,
          "data-testid": `reload-note-${path}`,
        }),
      );
    }
    if (field.help !== null) {
      row.append(element("div", { class: "form-tips" }, field.help));
    }
    (field.advanced === true ? advanced : container).append(row);
  }
  if (advanced.children.length > 1) {
    container.append(advanced);
  }
  wireOptions(container, fields);
}

// ── options read from Anytype (plan 0022 §B) ─────────────────────────────────────────────

const LOADING: OptionsState = { kind: "loading" };

/** A dynamic select drawn as the model says, and its note's sentence. */
function showSelect(select: HTMLSelectElement, model: DynamicSelect): void {
  select.replaceChildren(
    ...model.options.map((option) => element("option", { value: option.value }, option.label)),
  );
  select.value = model.value;
  select.disabled = model.disabled;
  const note = select.parentElement?.querySelector<HTMLElement>("[data-reload-note]");
  if (note !== null && note !== undefined) {
    note.textContent = model.sentence ?? "";
    note.hidden = model.sentence === null;
  }
}

/** The options route's answer; any failure to reach it is "unavailable", never a throw. */
async function fetchOptions(query: OptionsQuery): Promise<OptionsAnswer> {
  const search =
    query.source === "spaces"
      ? new URLSearchParams({ source: "spaces" })
      : new URLSearchParams({ source: "types", space: query.spaceId });
  try {
    // Relative to the editor's own /red/: the same origin, behind the same Host check.
    const response = await fetch(`reload/options?${search.toString()}`, { cache: "no-store" });
    return parseOptionsAnswer(await response.json()) ?? refusal("unavailable");
  } catch {
    return refusal("unavailable");
  }
}

/** The control of `key`'s row under `container`, when it has one. */
function controlOf(container: Element, key: string): Element | null {
  return rowOf(container, key)?.children[1] ?? null;
}

/**
 * Fill every dynamic select among `fields` directly under `container`. Only the newest
 * request of a select is shown: a slow answer for a space no longer chosen is dropped.
 */
function wireOptions(container: Element, fields: readonly Field[]): void {
  for (const field of fields) {
    const select = controlOf(container, field.key);
    const reload = field.reload;
    if (reload === undefined || !(select instanceof HTMLSelectElement)) {
      continue;
    }
    // A types select's space: the sibling `of` names, read live at each refresh.
    const of = reload.source === "types" ? reload.of : null;
    const sibling = of === null ? null : controlOf(container, of);
    let asked = 0;
    const refresh = (keepUnlisted: boolean): void => {
      const value = select.value;
      const siblings =
        of !== null && (sibling instanceof HTMLSelectElement || sibling instanceof HTMLInputElement)
          ? { [of]: sibling.value }
          : {};
      const query = optionsQueryOf(field, siblings);
      asked += 1;
      const mine = asked;
      if (query === null) {
        showSelect(select, dynamicSelect(field, value, { kind: "waiting" }));
        return;
      }
      showSelect(select, dynamicSelect(field, value, LOADING));
      void fetchOptions(query).then((answer) => {
        if (mine === asked) {
          const state: OptionsState = { kind: "answered", answer };
          showSelect(select, dynamicSelect(field, value, state, keepUnlisted));
        }
      });
    };
    // The person chose another space: its types are read again, and a type it lacks cleared.
    sibling?.addEventListener("change", () => {
      refresh(false);
    });
    refresh(true);
  }
}

/** A table: one row of the columns per element, and buttons to add, remove and reorder. */
function table(field: Field, path: string, rows: readonly Values[]): HTMLElement {
  const columns = field.fields ?? [];
  const holder = element("div", {
    class: "reload-table",
    "data-reload-table": path,
    "data-testid": `reload-table-${path}`,
  });
  const redraw = (next: readonly Values[]): void => {
    holder.replaceChildren();
    next.forEach((row, index) => {
      const rowPath = `${path}.${String(index)}`;
      const line = element("div", {
        class: "reload-row",
        "data-reload-row": rowPath,
        "data-testid": `reload-row-${rowPath}`,
      });
      draw(line, columns, row, rowPath);
      const button = (action: string, text: string, change: () => Values[]): void => {
        const pressed = element(
          "button",
          {
            type: "button",
            "data-reload-action": action,
            "data-testid": `reload-action-${action}`,
          },
          text,
        );
        pressed.addEventListener("click", () => {
          redraw(change());
        });
        line.append(pressed);
      };
      button("up", "↑", () => moveRow(readRows(holder, columns), index, index - 1));
      button("down", "↓", () => moveRow(readRows(holder, columns), index, index + 1));
      button("remove", "Remove", () => removeRow(readRows(holder, columns), index));
      holder.append(line);
    });
    const add = element(
      "button",
      { type: "button", "data-reload-action": "add", "data-testid": "reload-action-add" },
      "Add row",
    );
    add.addEventListener("click", () => {
      redraw(addRow(readRows(holder, columns), columns));
    });
    holder.append(add);
  };
  redraw(rows);
  return holder;
}

// ── reading back ─────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The direct child of `parent` carrying `attribute` = `value`, never one nested deeper. */
function own(parent: Element, attribute: string, value: string): Element | null {
  return [...parent.children].find((child) => child.getAttribute(attribute) === value) ?? null;
}

/** `key`'s row directly under `container`, or in its own Advanced disclosure; never deeper. */
function rowOf(container: Element, key: string): Element | null {
  const advanced = [...container.children].find((child) =>
    child.hasAttribute("data-reload-advanced"),
  );
  return (
    own(container, "data-reload-key", key) ??
    (advanced === undefined ? null : own(advanced, "data-reload-key", key))
  );
}

/** The values of `fields` as drawn under `container`: text as text, as Node-RED keeps it. */
function read(container: Element, fields: readonly Field[]): Values {
  const values: Values = {};
  for (const field of fields) {
    const row = rowOf(container, field.key);
    if (row === null) {
      continue;
    }
    const control = row.children[1];
    if (field.control === "group" && control !== undefined) {
      values[field.key] = read(control, field.fields ?? []);
    } else if (field.control === "table" && control !== undefined) {
      values[field.key] = readRows(control, field.fields ?? []);
    } else if (control instanceof HTMLInputElement && control.type === "checkbox") {
      values[field.key] = control.checked;
    } else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      values[field.key] = control.value;
    }
  }
  return values;
}

function readRows(holder: Element, columns: readonly Field[]): Values[] {
  return [...holder.children]
    .filter((child) => child.hasAttribute("data-reload-row"))
    .map((line) => read(line, columns));
}

/** The form container of the open edit dialog for `type`. */
function containerOf(type: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`.reload-form[data-reload-type="${type}"]`);
  if (found === null) {
    throw new Error(`Reload: the edit dialog of ${type} has no form container`);
  }
  return found;
}

/** oneditprepare: draw the form with the node's values. */
function prepare(type: string, node: Values): void {
  const container = containerOf(type);
  container.replaceChildren();
  draw(container, registered(type).fields, node, "");
}

/** oneditsave: the drawn values back onto the node. */
function save(type: string, node: Values): void {
  const values = read(containerOf(type), registered(type).fields);
  for (const [key, value] of Object.entries(values)) {
    node[key] = value;
  }
}

declare global {
  interface Window {
    ReloadForms?: {
      define: typeof define;
      validate: typeof validate;
      prepare: typeof prepare;
      save: typeof save;
    };
    /** Definitions Node-RED put in the page before this code: defined now. */
    ReloadFormsPending?: [string, JsonSchema][];
  }
}

window.ReloadForms = { define, validate, prepare, save };
for (const [type, schema] of window.ReloadFormsPending ?? []) {
  define(type, schema);
}
