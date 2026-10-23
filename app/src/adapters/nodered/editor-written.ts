// Who set a property, in the canvas form (spec 4.6, revision 2.2; plan 0032, WI-0032-41): as
// the form opens, what the node wrote of its own settings is read from /red/reload/written,
// and each property its package set last says so beside it, "Set by <package>, <time>"; a
// property only its package sets is drawn read-only (form-model.ts), holding what it wrote.
// A secret it wrote is never read here: the route says only that it is set.
//
// Like editor-forms.ts, this runs in the editor's browser page; its unit test draws in a DOM.

import type { Field } from "../../domain/forms/form-model";
import { attributionOf, personWrites, USER, type WrittenRecord } from "../../domain/forms/written";
import { element } from "./editor-options";
import { isRecord } from "./editor-read";

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
): void {
  const { record } = recordOf(answer);
  const by = attributionOf(record, personWrites(node));
  for (const field of fields) {
    const who = by[field.key];
    const row = [...container.children].find(
      (child) => child.getAttribute("data-reload-key") === field.key,
    );
    if (who === undefined || who.by === USER || row === undefined) {
      continue;
    }
    const control = row.querySelector<HTMLInputElement>(`[data-reload-field="${field.key}"]`);
    const value = record.values[field.key];
    if (field.writtenBy === "plugin" && control !== null && value !== undefined) {
      control.value = typeof value === "string" ? value : JSON.stringify(value);
    }
    const attributes = { class: "form-tips", "data-testid": `reload-written-${field.key}` };
    row.append(element("div", attributes, setBy(who.by, who.at)));
  }
}

/** Ask the route for what node `id` wrote, then draw it; nothing is drawn when it cannot be read. */
export function showWritten(
  container: Element,
  fields: readonly Field[],
  node: Readonly<Record<string, unknown>>,
): void {
  const id = node["id"];
  if (typeof id !== "string" || !fields.some((field) => field.writtenBy !== undefined)) {
    return;
  }
  void fetch(`reload/written?node=${encodeURIComponent(id)}`, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((answer: unknown) => {
      drawWritten(container, fields, node, answer);
    })
    .catch(() => undefined);
}
