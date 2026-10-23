// A table of the canvas form (editor-forms.ts draws the rest): one row of its columns per
// element, added, removed and reordered, as the old settings window drew it (plan 0005; plan
// 0032, group 4). Its buttons say what the package calls a row ("Add recorder", from the row's
// `title`); Remove asks first, on the row, when the row holds something, a nested row included;
// a row wider than three columns shows its first three until its More is used; and a table
// inside a row folds to its rows' first column. Folding and More only hide: every column is
// still read back on save.
//
// Like editor-forms.ts, this runs in the editor's browser page; its unit test draws in a DOM.

import { addRow, moveRow, removeRow, type Field } from "../../domain/forms/form-model";
import { element } from "./editor-options";
import { isRecord, originOf, read, readRows } from "./editor-read";

type Values = Record<string, unknown>;

/** How many of a row's columns are drawn before the rest go behind its More (old D7). */
export const SHOWN_COLUMNS = 3;

/** The words on a table's own controls (docs/ux/ux-writing.md, "A step's form"). */
export const TABLE_WORDS = {
  add: "Add",
  remove: "Remove",
  removeNow: "Remove it",
  keep: "Keep it",
  more: "More",
  fewer: "Fewer",
  collapse: "Collapse",
  expand: "Expand",
} as const;

/** What a table needs of the form that holds it. */
export interface TableHooks {
  /** Draw `columns` holding `row` into `line`, as the form draws any object. */
  draw(line: HTMLElement, columns: readonly Field[], row: Values, path: string): void;
  /** The person changed the rows: reasons drawn for the old rows no longer stand. */
  changed(): void;
  /** The reason kept for `path`, drawn to stand beside it; null when it has none. */
  reason(path: string): HTMLElement | null;
}

/** Whether a row holds anything a person typed or chose: a value, a list's element, a row. */
export function holdsSomething(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.values(value).some(holdsSomething);
  }
  return value !== undefined && value !== null && value !== "" && value !== false;
}

const button = (action: string, text: string): HTMLButtonElement =>
  element(
    "button",
    { type: "button", "data-reload-action": action, "data-testid": `reload-action-${action}` },
    text,
  );

/** The rows of fields directly in `line` (never a nested row's), in their order. */
const fieldRows = (line: Element): HTMLElement[] =>
  [...line.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute("data-reload-key"),
  );

/** `field`'s table at `path`, holding `rows`; `nested` when it is a column of another row. */
export function drawTable(
  field: Field,
  path: string,
  rows: readonly Values[],
  hooks: TableHooks,
  nested: boolean,
): HTMLElement {
  const columns = field.fields ?? [];
  // A row is never called "row" when the package names it (the row's `title`).
  const noun = field.rowLabel ?? "row";
  const holder = element("div", {
    class: "reload-table",
    "data-reload-table": path,
    "data-testid": `reload-table-${path}`,
  });
  if (nested) {
    // Drawn under the row that holds it, one step deeper than that row (old plan 0005, D1).
    holder.style.marginLeft = "16px";
    holder.setAttribute("data-reload-nested", "");
  }
  let folded = false;
  /** Folded, each row shows its first column alone; otherwise what its More says. */
  const fold = (): void => {
    const lines = [...holder.children].filter((child): child is HTMLElement =>
      child.hasAttribute("data-reload-row"),
    );
    for (const line of lines) {
      const open = line.getAttribute("data-reload-more") === "open";
      fieldRows(line).forEach((row, index) => {
        const shown = folded ? index === 0 : open || index < SHOWN_COLUMNS;
        row.style.display = shown ? "" : "none";
      });
      for (const more of [...line.children].filter(
        (child): child is HTMLElement => child.getAttribute("data-reload-action") === "more",
      )) {
        more.style.display = folded ? "none" : "";
      }
    }
  };
  const redraw = (next: readonly Values[]): void => {
    holder.replaceChildren();
    if (nested) {
      const toggle = button("fold", folded ? TABLE_WORDS.expand : TABLE_WORDS.collapse);
      toggle.addEventListener("click", () => {
        folded = !folded;
        toggle.textContent = folded ? TABLE_WORDS.expand : TABLE_WORDS.collapse;
        fold();
      });
      holder.append(toggle);
    }
    next.forEach((row, index) => {
      holder.append(rowLine(row, index));
    });
    const add = button("add", `${TABLE_WORDS.add} ${noun}`);
    add.addEventListener("click", () => {
      hooks.changed();
      redraw(addRow(readRows(holder, columns), columns));
    });
    holder.append(add);
    fold();
  };
  const rowLine = (row: Values, index: number): HTMLElement => {
    const rowPath = `${path}.${String(index)}`;
    const line = element("div", {
      class: "reload-row",
      "data-reload-row": rowPath,
      "data-testid": `reload-row-${rowPath}`,
    });
    const origin = originOf.get(row);
    if (origin !== undefined) {
      line.setAttribute("data-reload-origin", String(origin));
    }
    hooks.draw(line, columns, row, rowPath);
    // A row's own reason (a key its row does not take): on the row, never on a cell.
    const reason = hooks.reason(rowPath);
    if (reason !== null) {
      line.append(reason);
    }
    if (columns.length > SHOWN_COLUMNS) {
      const hidden = columns.length - SHOWN_COLUMNS;
      const more = button("more", `${TABLE_WORDS.more} (${String(hidden)})`);
      more.addEventListener("click", () => {
        const open = line.getAttribute("data-reload-more") !== "open";
        line.setAttribute("data-reload-more", open ? "open" : "closed");
        more.textContent = open ? TABLE_WORDS.fewer : `${TABLE_WORDS.more} (${String(hidden)})`;
        fold();
      });
      line.append(more);
    }
    const change = (action: string, text: string, next: () => Values[]): void => {
      const pressed = button(action, text);
      pressed.addEventListener("click", () => {
        hooks.changed();
        redraw(next());
      });
      line.append(pressed);
    };
    change("up", "↑", () => moveRow(readRows(holder, columns), index, index - 1));
    change("down", "↓", () => moveRow(readRows(holder, columns), index, index + 1));
    const remove = button("remove", TABLE_WORDS.remove);
    remove.addEventListener("click", () => {
      // An empty row goes at once; one that holds something asks first, on the row (old D5).
      if (!holdsSomething(read(line, columns))) {
        hooks.changed();
        redraw(removeRow(readRows(holder, columns), index));
        return;
      }
      if (line.querySelector("[data-reload-question]") !== null) {
        return;
      }
      const name = `${noun} ${String(index + 1)}`;
      const question = element("div", {
        class: "form-tips",
        "data-reload-question": rowPath,
        "data-testid": `reload-question-${rowPath}`,
      });
      question.append(`${name} holds values. Remove it? `);
      const now = button("remove-now", TABLE_WORDS.removeNow);
      now.addEventListener("click", () => {
        hooks.changed();
        redraw(removeRow(readRows(holder, columns), index));
      });
      const keep = button("keep", TABLE_WORDS.keep);
      keep.addEventListener("click", () => {
        question.remove();
      });
      question.append(now, keep);
      line.append(question);
    });
    line.append(remove);
    return line;
  };
  redraw(rows);
  return holder;
}
