// The generated types' forms, inside the Node-RED editor (spec 2.5, WI-0018-09).
//
// Bundled on its own for the browser (`npm run build:editor`) and written once into the
// generated folder as reload-forms.html, which Node-RED puts in the editor page with every node
// definition. Each generated type calls `window.ReloadForms` from its oneditprepare, oneditsave
// and property validators. It draws the form model of domain/forms (text, several lines of text,
// a path with Browse…, number, integer, checkbox, select, ticked options, a list of values,
// nested groups, and tables whose rows are added, removed and reordered), marks the required
// fields, and validates the node with ajv before it can be deployed cleanly: a node whose
// values the schema refuses is shown invalid, with the reason.
//
// Saving keeps what passes and nothing that fails (domain/forms/kept-on-save.ts): a refused
// field keeps its value from before, a refused row the row that was at its place, and the
// editor says what was not kept; opening the form again shows what was typed beside why.
//
// A string property whose options come from Anytype is a select filled as the form opens
// (editor-options.ts, with the DOM helpers both files draw with).
//
// A property marked `reload.advanced` (spec 2.4.1) is drawn as any other, but in a closed
// "Advanced" disclosure after the others; it is read back from there the same way.
//
// A top-level secret is not drawn here: it is a Node-RED credential input in the type's own
// template, which Node-RED fills and saves itself, and never hands back to the editor (spec
// 2.5.2). A secret inside a group is the same credential, named by its path ("account.token"),
// drawn here in its group, as Node-RED's own inputs are drawn: "set" shown, never its value.
//
// This file runs only in the editor's browser page, so no unit test loads it; it is excluded
// from coverage like the preload bridge, and the e2e drives it in the real editor. So does the
// form's every rule: what is kept on a save is domain/forms/kept-on-save.ts, unit-tested.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import { browseUrl } from "../../domain/forms/browse";
import { coerceObject } from "../../domain/forms/coerce";
import { keptOnSave, notKeptSentence } from "../../domain/forms/kept-on-save";
import { RELOAD_ANNOTATION } from "../../domain/forms/reload-keyword";
import {
  ADVANCED_LABEL,
  addRow,
  describedProblems,
  dynamicSelect,
  formModel,
  moveRow,
  removeRow,
  withoutSecrets,
  type Field,
} from "../../domain/forms/form-model";
import type { JsonSchema } from "../../domain/packages/declaration";
import { element, LOADING, rowOf, showSelect, wireOptions } from "./editor-options";

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
  // Drawn from the whole schema, so a secret in a group has its place; judged without them.
  const fields = formModel(schema).fields;
  types.set(type, { schema: plain, fields, validate: ajv.compile(plain) });
}

/** The node's own values for its declared, non-secret properties, as Node-RED keeps them. */
function ownOf(entry: Registered, node: Values): Values {
  const plain = entry.fields.filter((field) => field.control !== "password");
  return Object.fromEntries(plain.map((field) => [field.key, node[field.key]]));
}

/** The node's values for its declared properties, coerced as the runtime will coerce them. */
function valuesOf(entry: Registered, node: Values): Values {
  return coerceObject(entry.schema, ownOf(entry, node));
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

/** The inputs a Browse… may fill, by number, for the form open now. */
let browsing: HTMLInputElement[] = [];

/** One control of `field`, holding `value`: anything but a group or a table. */
function control(field: Field, path: string, value: unknown): HTMLElement {
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
      const step = field.step ?? (field.control === "integer" ? 1 : "any");
      const bounds = Object.fromEntries(
        (["min", "max"] as const).flatMap((at) => {
          const bound = field[at];
          return bound === undefined ? [] : [[at, String(bound)]];
        }),
      );
      const attributes = { ...common, ...bounds, type: "number", step: String(step) };
      const input = element("input", { ...attributes, style: "width:70%" });
      input.value = textOf(value);
      return input;
    }
    case "textarea": {
      const box = element("textarea", { ...common, rows: "4", style: "width:70%" });
      box.value = textOf(value);
      return box;
    }
    case "path": {
      const holder = element("div", { "data-reload-path": path, style: "display:inline-block" });
      const input = element("input", { ...common, type: "text", style: "width:70%" });
      input.value = textOf(value);
      const browse = element("button", { type: "button", "data-testid": `reload-browse-${path}` });
      browse.textContent = BROWSE_LABEL;
      const number = browsing.push(input) - 1;
      browse.addEventListener("click", () => {
        window.open(browseUrl(field.pathKind ?? "file", number));
      });
      holder.append(input, browse);
      return holder;
    }
    case "multiselect": {
      const chosen = Array.isArray(value) ? value : [];
      const holder = element("div", { ...common, role: "group", "data-reload-multi": path });
      (field.options ?? []).forEach((option, index) => {
        const box = element("input", {
          type: "checkbox",
          style: "width:auto",
          "data-reload-option": String(index),
          "data-testid": `reload-option-${path}-${String(index)}`,
        });
        box.checked = chosen.some((each) => String(each) === String(option));
        const label = element("label", { style: "width:auto;margin-right:12px" });
        label.append(box, ` ${String(option)}`);
        holder.append(label);
      });
      return holder;
    }
    case "list":
      return list(field, path, Array.isArray(value) ? value : []);
    case "text": {
      const input = element("input", { ...common, type: "text", style: "width:70%" });
      input.value = textOf(value);
      return input;
    }
    case "group":
    case "table":
    case "password":
      throw new Error(`Reload: a ${field.control} is drawn by the form, not as one control`);
    default: {
      // Every control has a drawing: one without is a build error, never a field left off.
      const missing: never = field.control;
      throw new Error(`Reload: no drawing for the ${String(missing)} control`);
    }
  }
}

/** A list of single values: one control of its element each, removed or added one at a time. */
function list(field: Field, path: string, values: readonly unknown[]): HTMLElement {
  const holder = element("div", { "data-reload-list": path, "data-testid": `reload-list-${path}` });
  const element_ = field.element ?? { ...field, control: "text" };
  const redraw = (next: readonly unknown[]): void => {
    holder.replaceChildren();
    next.forEach((value, index) => {
      const itemPath = `${path}.${String(index)}`;
      const item = element("div", { "data-reload-item": itemPath });
      item.append(control(element_, itemPath, value));
      const remove = element("button", { type: "button", "data-testid": "reload-item-remove" });
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        redraw(readList(holder, element_).filter((_, at) => at !== index));
      });
      item.append(remove);
      holder.append(item);
    });
    const add = element("button", { type: "button", "data-testid": `reload-item-add-${path}` });
    add.textContent = "Add";
    add.addEventListener("click", () => {
      redraw([...readList(holder, element_), element_.default ?? ""]);
    });
    holder.append(add);
  };
  redraw(values);
  return holder;
}

/** A secret inside a group: its credential's input, showing only whether it is set. */
function secret(path: string): HTMLInputElement {
  const input = element("input", {
    type: "password",
    style: "width:70%",
    "data-reload-secret": path,
    "data-testid": `reload-secret-${path}`,
  });
  const held = editing?.["credentials"];
  input.value = isRecord(held) && held[`has_${path}`] === true ? SET : "";
  return input;
}

/** The controls of `fields`, holding `values`, under `container`; the advanced ones folded. */
function draw(container: HTMLElement, fields: readonly Field[], values: Values, prefix: string) {
  const advanced = element("details", {
    "data-reload-advanced": "",
    "data-testid": `reload-advanced${prefix === "" ? "" : `-${prefix}`}`,
  });
  advanced.append(element("summary", {}, ADVANCED_LABEL));
  for (const field of fields) {
    if (field.control === "password" && prefix === "") {
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
    } else if (field.control === "password") {
      row.append(secret(path));
    } else {
      row.append(control(field, path, value));
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

/** What a set secret's input holds: Node-RED's own placeholder, never the value. */
const SET = "__PWRD__";

/** The button beside a path field. */
const BROWSE_LABEL = "Browse…";

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

/** The value of `field` as drawn by `drawn`: text as text, as Node-RED keeps it. */
function valueOf(field: Field, drawn: Element): unknown {
  switch (field.control) {
    case "group":
      return read(drawn, field.fields ?? []);
    case "table":
      return readRows(drawn, field.fields ?? []);
    case "list":
      return readList(drawn, field.element ?? { ...field, control: "text" });
    case "multiselect":
      return (field.options ?? []).filter(
        (_, index) =>
          drawn.querySelector<HTMLInputElement>(`[data-reload-option="${String(index)}"]`)
            ?.checked === true,
      );
    case "path":
      return drawn.querySelector("input")?.value ?? "";
    default:
      if (drawn instanceof HTMLInputElement && drawn.type === "checkbox") {
        return drawn.checked;
      }
      return drawn instanceof HTMLInputElement ||
        drawn instanceof HTMLSelectElement ||
        drawn instanceof HTMLTextAreaElement
        ? drawn.value
        : undefined;
  }
}

/** The values of `fields` as drawn under `container`; a secret is never among them. */
function read(container: Element, fields: readonly Field[]): Values {
  const values: Values = {};
  for (const field of fields) {
    const drawn = rowOf(container, field.key)?.children[1];
    const value =
      drawn === undefined || field.control === "password" ? undefined : valueOf(field, drawn);
    if (value !== undefined) {
      values[field.key] = value;
    }
  }
  return values;
}

function readRows(holder: Element, columns: readonly Field[]): Values[] {
  return [...holder.children]
    .filter((child) => child.hasAttribute("data-reload-row"))
    .map((line) => read(line, columns));
}

function readList(holder: Element, item: Field): unknown[] {
  return [...holder.children]
    .filter((child) => child.hasAttribute("data-reload-item"))
    .map((line) => (line.children[0] === undefined ? "" : valueOf(item, line.children[0])));
}

/** The form container of the open edit dialog for `type`. */
function containerOf(type: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`.reload-form[data-reload-type="${type}"]`);
  if (found === null) {
    throw new Error(`Reload: the edit dialog of ${type} has no form container`);
  }
  return found;
}

/** The node whose form is open: its credentials say which secrets are set. */
let editing: Values | null = null;

/** What a save did not keep, by node id: shown with its reasons as that node's form opens. */
const refusedOf = new Map<string, { values: Values; sentence: string }>();

/** oneditprepare: draw the form with the node's values, or with what it last refused. */
function prepare(type: string, node: Values): void {
  const container = containerOf(type);
  container.replaceChildren();
  editing = node;
  browsing = [];
  const refused = refusedOf.get(String(node["id"]));
  refusedOf.delete(String(node["id"]));
  if (refused !== undefined) {
    const said = { class: "form-tips reload-refused", "data-testid": "reload-refused" };
    container.append(element("div", said, refused.sentence));
  }
  draw(container, registered(type).fields, { ...node, ...refused?.values }, "");
}

/**
 * oneditsave: what passes back onto the node, what fails left as it was (kept-on-save.ts), and
 * each secret drawn in a group to its credential. True when a secret changed, which Node-RED
 * cannot see itself.
 */
function save(type: string, node: Values): boolean {
  const entry = registered(type);
  const container = containerOf(type);
  const submitted = read(container, entry.fields);
  const previous = ownOf(entry, node);
  const kept = keptOnSave(entry.schema, previous, submitted, (value) =>
    entry.validate(value) ? [] : problems(entry.validate),
  );
  for (const [key, value] of Object.entries(kept.values)) {
    node[key] = value;
  }
  if (kept.refused.length > 0) {
    const sentence = notKeptSentence(describedProblems(entry.schema, kept.refused));
    refusedOf.set(String(node["id"]), { values: submitted, sentence });
    window.RED?.notify(sentence, "warning");
  }
  return saveSecrets(container, node);
}

/** Each secret drawn in a group to its credential, as Node-RED saves its own inputs. */
function saveSecrets(container: Element, node: Values): boolean {
  const held: Values = isRecord(node["credentials"]) ? node["credentials"] : {};
  node["credentials"] = held;
  let changed = false;
  for (const input of container.querySelectorAll<HTMLInputElement>("[data-reload-secret]")) {
    const name = input.getAttribute("data-reload-secret") ?? "";
    const set = held[`has_${name}`] === true;
    if (input.value === SET || (input.value === "" && !set)) {
      continue;
    }
    held[name] = input.value;
    held[`has_${name}`] = input.value !== "";
    changed = true;
  }
  return changed;
}

/** A path chosen with Browse… (shell/editor-browse.ts), into the field it was asked for. */
function browsed(field: number, path: string): void {
  const input = browsing[field];
  if (input !== undefined && input.isConnected) {
    input.value = path;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

declare global {
  interface Window {
    ReloadForms?: {
      define: typeof define;
      validate: typeof validate;
      prepare: typeof prepare;
      save: typeof save;
      browsed: typeof browsed;
    };
    /** The editor's own RED, as far as the form uses it. */
    RED?: { notify(message: string, type: string): void };
    /** Definitions Node-RED put in the page before this code: defined now. */
    ReloadFormsPending?: [string, JsonSchema][];
  }
}

window.ReloadForms = { define, validate, prepare, save, browsed };
for (const [type, schema] of window.ReloadFormsPending ?? []) {
  define(type, schema);
}
