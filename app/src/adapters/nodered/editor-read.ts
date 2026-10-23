// The canvas form read back (editor-forms.ts draws it): each drawn control's value as Node-RED
// keeps it, each row remembering the stored row it was drawn from (row-origins.ts), each secret
// drawn in a group saved to its credential as Node-RED saves its own inputs, and each secret no
// credential can hold (unkept.ts) found where something was typed into it, to be refused.
//
// Like editor-forms.ts, this runs in the editor's browser page; its unit test draws in a DOM.

import type { Field } from "../../domain/forms/form-model";
import { rowOf } from "./editor-options";

type Values = Record<string, unknown>;

/** What a set secret's input holds: Node-RED's own placeholder, never the value. */
export const SET = "__PWRD__";

export const isRecord = (value: unknown): value is Values =>
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
export function read(container: Element, fields: readonly Field[]): Values {
  const values: Values = {};
  for (const field of fields) {
    const drawn = rowOf(container, field.key)?.children[1];
    const secret = field.control === "password" || field.control === "unkept";
    const value = drawn === undefined || secret ? undefined : valueOf(field, drawn);
    if (value !== undefined) {
      values[field.key] = value;
    }
  }
  return values;
}

/** The rows drawn under `holder`, each remembering the row it was drawn from, if any. */
export function readRows(holder: Element, columns: readonly Field[]): Values[] {
  return [...holder.children]
    .filter((child) => child.hasAttribute("data-reload-row"))
    .map((line) => {
      const row = read(line, columns);
      const origin = line.getAttribute("data-reload-origin");
      if (origin !== null) {
        originOf.set(row, Number(origin));
      }
      return row;
    });
}

/**
 * Which stored row each drawn row was drawn from (kept-on-save.ts matches rows by it, never by
 * their place): set for the node's own rows as its form opens, carried by every move.
 */
export const originOf = new WeakMap<object, number>();

export function readList(holder: Element, item: Field): unknown[] {
  return [...holder.children]
    .filter((child) => child.hasAttribute("data-reload-item"))
    .map((line) => (line.children[0] === undefined ? "" : valueOf(item, line.children[0])));
}

/** Each secret drawn in a group to its credential, as Node-RED saves its own inputs. */
export function saveSecrets(container: Element, node: Values): boolean {
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

/** The paths ("volumes.0.token") of each secret no credential can hold that holds a typing. */
export function typedUnkept(container: Element): string[] {
  return [...container.querySelectorAll<HTMLInputElement>("[data-reload-unkept]")]
    .filter((input) => input.value !== "")
    .map((input) => input.getAttribute("data-reload-unkept") ?? "");
}
