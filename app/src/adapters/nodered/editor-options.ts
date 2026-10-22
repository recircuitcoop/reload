// The canvas form's DOM helpers and its options read from Anytype (plan 0022 §B), apart from
// editor-forms.ts, which draws the rest. A string property whose options come from Anytype
// (`reload.spaces`, `reload.types.of`) is a select filled from the admin route
// /red/reload/options as the form opens: "Reading your spaces…", then the names, each storing
// its plain id or key. A types select reads its sibling space and reads again when that
// changes; with no space it is empty and disabled. Not paired, the sentence shows in place of
// the options, and the stored value stays.
//
// Like editor-forms.ts, this runs only in the editor's browser page: the e2e drives it there.

import {
  dynamicSelect,
  optionsQueryOf,
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

export const LOADING: OptionsState = { kind: "loading" };

export function element<K extends keyof HTMLElementTagNameMap>(
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

/** A dynamic select drawn as the model says, and its note's sentence. */
export function showSelect(select: HTMLSelectElement, model: DynamicSelect): void {
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
export function wireOptions(container: Element, fields: readonly Field[]): void {
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

/** The direct child of `parent` carrying `attribute` = `value`, never one nested deeper. */
function own(parent: Element, attribute: string, value: string): Element | null {
  return [...parent.children].find((child) => child.getAttribute(attribute) === value) ?? null;
}

/** `key`'s row directly under `container`, or in its own Advanced disclosure; never deeper. */
export function rowOf(container: Element, key: string): Element | null {
  const advanced = [...container.children].find((child) =>
    child.hasAttribute("data-reload-advanced"),
  );
  return (
    own(container, "data-reload-key", key) ??
    (advanced === undefined ? null : own(advanced, "data-reload-key", key))
  );
}
