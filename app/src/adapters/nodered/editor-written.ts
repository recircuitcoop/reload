// Who set a property, in the canvas form (spec 4.6, revision 2.3; plan 0032, WI-0032-41): as
// the form opens, what the node wrote of its own settings is read from /red/reload/written,
// and each property whose value in force is its package's says so beside it, "Set by
// <package>, <time>", and shows that value; a property only its package sets is drawn
// read-only (form-model.ts). Shown, the package's value is the package's: a save that sends it
// back unchanged keeps the node's own (`echoed`), never writing it into the flows as the
// person's. A secret it wrote is never read here: the route says only that it is set.
//
// Like editor-forms.ts, this runs in the editor's browser page; its unit test draws in a DOM.

import type { Field } from "../../domain/forms/form-model";
import type { JsonSchema } from "../../domain/packages/declaration";
import { attributionOf, personWrites, USER, type WrittenRecord } from "../../domain/forms/written";
import { element } from "./editor-options";
import { isRecord } from "./editor-read";

/** By the node's id, what the form shows of its package's values in force, as their text. */
export const echoed = new Map<string, Record<string, string>>();

/** The package of a generated type, `reload-<package>-<id>`: a package name has no hyphen. */
export const packageOf = (type: string): string => type.split("-")[1] ?? "";

/** The note beside a property its package set last. */
export function setBy(by: string, at: string): string {
  return `Set by ${by}, ${new Date(at).toLocaleString()}`;
}

/** What the route answered, as a record without its secrets' values. */
function recordOf(answer: unknown): { record: WrittenRecord; set: readonly string[] } {
  const body = isRecord(answer) ? answer : {};
  const values = isRecord(body["values"]) ? body["values"] : {};
  const written = isRecord(body["written"]) ? body["written"] : {};
  const set = Array.isArray(body["set"])
    ? body["set"].filter((each) => typeof each === "string")
    : [];
  const record: WrittenRecord = {
    values,
    // Only the names: a value is never in the answer.
    secrets: Object.fromEntries(set.map((name) => [name, ""])),
    written: Object.fromEntries(
      Object.entries(written).flatMap(([key, by]) =>
        isRecord(by) && typeof by["by"] === "string" && typeof by["at"] === "string"
          ? [[key, { by: by["by"], at: by["at"] }]]
          : [],
      ),
    ),
  };
  return { record, set };
}

/**
 * Draw who set each top-level property of `fields` under `container`, for the node `node`,
 * from `answer` (the route's answer): its package's note, and the value it wrote into a field
 * only its package sets.
 */
export function drawWritten(
  container: Element,
  fields: readonly Field[],
  node: Readonly<Record<string, unknown>>,
  answer: unknown,
  schema: JsonSchema,
): void {
  const { record } = recordOf(answer);
  const own = packageOf(typeof node["type"] === "string" ? node["type"] : "");
  const by = attributionOf(record, personWrites(node), schema, own);
  const shown: Record<string, string> = {};
  for (const field of fields) {
    const who = by[field.key];
    const row = [...container.children].find(
      (child) => child.getAttribute("data-reload-key") === field.key,
    );
    if (who === undefined || who.by === USER || row === undefined) {
      continue;
    }
    // The value in force is the package's: shown as it is, for either writer.
    const control = row.querySelector<HTMLInputElement>(`[data-reload-field="${field.key}"]`);
    const value = record.values[field.key];
    if (control !== null && value !== undefined) {
      control.value = typeof value === "string" ? value : JSON.stringify(value);
      shown[field.key] = control.value;
    }
    const attributes = { class: "form-tips", "data-testid": `reload-written-${field.key}` };
    row.append(element("div", attributes, setBy(who.by, who.at)));
  }
  if (typeof node["id"] === "string") {
    echoed.set(node["id"], shown);
  }
}

/**
 * `submitted` (the form read back) with each value the form showed as its package's, sent back
 * unchanged, replaced by the node's own: so it is neither written as the person's nor stamped.
 */
export function withoutEchoes(
  submitted: Readonly<Record<string, unknown>>,
  node: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const shown = echoed.get(typeof node["id"] === "string" ? node["id"] : "") ?? {};
  return Object.fromEntries(
    Object.entries(submitted).flatMap(([key, value]): [string, unknown][] => {
      if (shown[key] === undefined || shown[key] !== value) {
        return [[key, value]];
      }
      return key in node ? [[key, node[key]]] : [];
    }),
  );
}

/** Ask the route for what node `id` wrote, then draw it; nothing is drawn when it cannot be read. */
export function showWritten(
  container: Element,
  fields: readonly Field[],
  node: Readonly<Record<string, unknown>>,
  schema: JsonSchema,
): void {
  const id = node["id"];
  if (typeof id !== "string" || !fields.some((field) => field.writtenBy !== undefined)) {
    return;
  }
  echoed.delete(id);
  void fetch(`reload/written?node=${encodeURIComponent(id)}`, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((answer: unknown) => {
      drawWritten(container, fields, node, answer, schema);
    })
    .catch(() => undefined);
}
