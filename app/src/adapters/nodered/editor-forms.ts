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
// editor says what was not kept, with what was typed, and again as the form next opens.
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

import { Ajv2020 } from "ajv/dist/2020.js";

import { browseUrl } from "../../domain/forms/browse";
import { coerceObject, emptyRequired } from "../../domain/forms/coerce";
import { hiddenPaths, unhidden } from "../../domain/forms/hidden";
import {
  droppedSentence,
  keptOnSave,
  notKeptSentence,
  readRefusal,
  REFUSED_KEY,
  storedRefusal,
  type Problem,
} from "../../domain/forms/kept-on-save";
import { originsOf, seedOrigins, seedRecorded } from "../../domain/forms/row-origins";
import { uniqueClashes } from "../../domain/forms/unique";
import { RELOAD_ANNOTATION } from "../../domain/forms/reload-keyword";
import {
  ADVANCED_LABEL,
  dynamicSelect,
  formModel,
  hiddenKeys,
  withoutSecrets,
  type Field,
} from "../../domain/forms/form-model";
import type { JsonSchema } from "../../domain/packages/declaration";
import { judge, nodeProblems, ownOf, problems, UNKEPT, type Registered } from "./editor-judge";
import { element, LOADING, rowOf, showSelect, wireOptions } from "./editor-options";
import { drawTable } from "./editor-table";
import { isRecord, originOf, read, readList, saveSecrets, SET, typedUnkept } from "./editor-read";

type Values = Record<string, unknown>;

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
  types.set(type, { schema: plain, full: schema, fields, validate: ajv.compile(plain) });
}

/** Node-RED's validator for one property: true, or the reason it is refused (editor-judge.ts). */
function validate(type: string, node: Values, key: string): true | string {
  return judge(registered(type), node, key);
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
      browse.addEventListener("click", () => {
        window.open(browseUrl(field.pathKind ?? "file", editingId(), path));
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
    case "unkept": {
      // Typed, never kept: a save refuses what is typed here (unkept.ts), and it is never read.
      const attributes = { ...common, type: "password", "data-reload-unkept": path };
      return element("input", { ...attributes, style: "width:70%" });
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
        reasons.clear();
        redraw(readList(holder, element_).filter((_, at) => at !== index));
      });
      item.append(remove);
      holder.append(item);
    });
    const add = element("button", { type: "button", "data-testid": `reload-item-add-${path}` });
    add.textContent = "Add";
    add.addEventListener("click", () => {
      reasons.clear();
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

/** The reason kept for `path`, drawn to stand beside it; null when it has none. */
function reasonBeside(path: string): HTMLElement | null {
  const reason = reasons.get(path);
  const attributes = { class: "form-tips reload-error", "data-testid": `reload-error-${path}` };
  return reason === undefined ? null : element("div", attributes, reason);
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
      const rows = Array.isArray(value) ? (value as Values[]) : [];
      const hooks = {
        draw,
        changed: () => {
          reasons.clear();
        },
        reason: reasonBeside,
      };
      row.append(drawTable(field, path, rows, hooks, prefix !== ""));
    } else if (field.control === "password") {
      row.append(secret(path));
    } else {
      row.append(control(field, path, value));
    }
    if (field.readOnly === true) {
      // Shown, never typed over: a save keeps the value it had (kept-on-save.ts).
      for (const input of row.querySelectorAll("input, select, textarea, button")) {
        input.setAttribute("disabled", "");
      }
    }
    const reason = reasonBeside(path);
    if (reason !== null) {
      // A table's own reason stands first in it, above its rows, once (inside the table, so the
      // row's control stays the one read back); any other field's after its control.
      const table = field.control === "table" ? row.querySelector(".reload-table") : null;
      if (table === null) {
        row.append(reason);
      } else {
        table.prepend(reason);
      }
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
  // A field with `reload.shown` is drawn only while its sibling holds the value it names; it
  // stays in the form, hidden, so its value is kept (form-model.ts hiddenKeys).
  if (fields.some((field) => field.shown !== undefined)) {
    const follow = (): void => {
      const hidden = hiddenKeys(fields, read(container, fields));
      for (const field of fields.filter((each) => each.shown !== undefined)) {
        const row = rowOf(container, field.key);
        if (row instanceof HTMLElement) {
          row.hidden = hidden.has(field.key);
        }
      }
    };
    follow();
    container.addEventListener("change", follow);
    container.addEventListener("input", follow);
  }
}

/** The button beside a path field. */
const BROWSE_LABEL = "Browse…";

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

/** The id of the node whose form is open; "" with none. */
function editingId(): string {
  const id = editing?.["id"];
  return typeof id === "string" ? id : "";
}

/** Why each typed value was not kept, by its path in the form open now ("volumes.1.gain"). */
const reasons = new Map<string, string>();

/** The one sentence of a field's refusal ("Gain: must be 1 or more, not "0"."). */
const reasonOf = (schema: JsonSchema, problem: Problem): string =>
  notKeptSentence(schema, [problem])
    .replace(/^Not saved: /, "")
    .replace(/ The value each had before is kept\.$/, "");

/**
 * oneditprepare: draw the form with the node's values; or, while a save of it stands refused
 * (kept on the node, so a reload of the editor keeps it too), with what was typed, each reason
 * beside its field, and every row matched to where its stored row now stands.
 */
function prepare(type: string, node: Values): void {
  const container = containerOf(type);
  container.replaceChildren();
  editing = node;
  reasons.clear();
  const { fields, full } = registered(type);
  const refused = readRefusal(node[REFUSED_KEY]);
  if (refused === null) {
    // What is wrong with the node now (a value its type no longer takes, a required one left
    // empty), each reason beside its field, its row or its table (editor-judge.ts).
    for (const problem of nodeProblems(registered(type), node)) {
      const path = problem.path.slice(1).replaceAll("/", ".");
      const reason = reasonOf(full, problem);
      reasons.set(path, [reasons.get(path), reason].filter(Boolean).join(" "));
    }
    seedOrigins(fields, node, originOf);
    draw(container, fields, node, "");
    return;
  }
  const said = { class: "form-tips reload-refused", "data-testid": "reload-refused" };
  container.append(element("div", said, notKeptSentence(full, refused.problems)));
  for (const problem of refused.problems) {
    reasons.set(problem.path.slice(1).replaceAll("/", "."), reasonOf(full, problem));
  }
  // The node's own rows first: a table the refusal holds no typing of is drawn from them.
  seedOrigins(fields, node, originOf);
  seedRecorded(fields, refused.values, new Map(refused.origins), originOf);
  draw(container, fields, { ...node, ...refused.values }, "");
}

/**
 * oneditsave: what passes back onto the node, what fails left as it was (kept-on-save.ts) and
 * kept on the node with what was typed until a save corrects it, a secret typed where no
 * credential can hold it refused, and each secret drawn in a group to its credential. True when
 * a secret changed, which Node-RED cannot see itself.
 */
function save(type: string, node: Values): boolean {
  const entry = registered(type);
  const container = containerOf(type);
  const submitted = read(container, entry.fields);
  // A row whose required cell is empty, or whose required nested table holds no row, is
  // refused like any other bad row; an empty required field at the top is saved and the node
  // held, as the runtime refuses it (coerce.ts emptyRequired).
  const check = (value: Values) => {
    const found = entry.validate(value) ? [] : problems(entry.validate);
    const all = [
      ...found,
      ...emptyRequired(entry.schema, value, "", found).filter(({ path }) =>
        /\/\d+(\/|$)/.test(path),
      ),
      // A row repeating another's unique value is refused, each naming the other (unique.ts).
      ...uniqueClashes(entry.schema, value),
    ];
    // Nothing a condition hides is judged while it is hidden (hidden.ts).
    return unhidden(all, hiddenPaths(entry.full, coerceObject(entry.schema, value)));
  };
  const origins = originsOf(entry.fields, submitted, originOf);
  const kept = keptOnSave(entry.schema, ownOf(entry, node), submitted, check, origins);
  const unkept = typedUnkept(container).map((path) => ({
    path: `/${path.replaceAll(".", "/")}`,
    message: UNKEPT,
  }));
  for (const [key, value] of Object.entries(kept.values)) {
    node[key] = value;
  }
  const all = { ...kept, refused: [...kept.refused, ...unkept] };
  // Kept and said without a secret's value, at any depth (storedRefusal).
  const stored = storedRefusal(entry.full, submitted, all);
  node[REFUSED_KEY] = stored;
  const said = [
    ...(stored === null ? [] : [notKeptSentence(entry.full, stored.problems)]),
    ...(kept.dropped.length === 0 ? [] : [droppedSentence(kept.dropped)]),
  ];
  if (said.length > 0) {
    window.RED?.notify(said.join(" "), "warning");
  }
  const changed = saveSecrets(container, node);
  editing = null;
  return changed;
}

/** oneditcancel: the form is closed, and a late Browse… answer has nowhere to go. */
function close(): void {
  editing = null;
  reasons.clear();
}

/**
 * A path chosen with Browse… (shell/editor-browse.ts), into the field of the node's form that
 * asked; dropped when that form is no longer the one open.
 */
function browsed(node: string, field: string, path: string): void {
  const form = document.querySelector(".reload-form");
  const input = form?.querySelector(`input[data-reload-field="${CSS.escape(field)}"]`);
  if (editingId() === node && input instanceof HTMLInputElement) {
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
      close: typeof close;
      browsed: typeof browsed;
    };
    /** The editor's own RED, as far as the form uses it. */
    RED?: {
      notify(message: string, type: string): void;
      menu?: { setSelected(id: string, selected: boolean): void };
    };
    /** Definitions Node-RED put in the page before this code: defined now. */
    ReloadFormsPending?: [string, JsonSchema][];
  }
}

window.ReloadForms = { define, validate, prepare, save, close, browsed };
// Deploy only the modified nodes (plan 0032, group 37): saving one step's setting restarts that
// step's process alone, as the old app restarted only that plugin. Node-RED's own default, a
// full deploy, would restart every node of every flow. The person may still choose another.
window.RED?.menu?.setSelected("deploymenu-item-node", true);
// One type whose form cannot be built never costs the types after it: each is defined alone.
for (const [type, schema] of window.ReloadFormsPending ?? []) {
  try {
    define(type, schema);
  } catch (error) {
    console.error(`Reload: the form of ${type} could not be built: ${String(error)}`);
  }
}
