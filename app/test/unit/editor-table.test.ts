// @vitest-environment happy-dom
//
// A table of the canvas form (adapters/nodered/editor-table.ts) in a DOM, as the old settings
// window drew one (tests/test_table_drawing.py, test_table_store.py; plan 0032, group 4): its
// buttons say what the package calls a row, Remove asks first on a row that holds something, a
// wide row shows its first columns until its More is used, a table in a row folds, and a save
// refuses each row repeating another's unique value, naming the other.

import { beforeAll, describe, expect, it } from "vitest";

import "../../src/adapters/nodered/editor-forms";
import {
  holdsSomething,
  SHOWN_COLUMNS,
  TABLE_WORDS,
} from "../../src/adapters/nodered/editor-table";
import { uniqueClashes } from "../../src/domain/forms/unique";

const TYPE = "reload-demo-recorders";

const text = (title: string, more: Record<string, unknown> = {}) => ({
  type: "string",
  title,
  ...more,
});

/** monty's recorder: wide, with a unique name, and takes holding markers. */
const SCHEMA = {
  type: "object",
  properties: {
    volumes: {
      type: "array",
      title: "Recorders",
      items: {
        type: "object",
        title: "recorder",
        properties: {
          name: text("Name", { default: "New recorder", reload: { unique: true } }),
          volume_uuid: text("Volume UUID"),
          volume_name: text("Volume name"),
          language: { type: "string", title: "Language", enum: ["nl", "fr", "en"], default: "nl" },
          gain: { type: "number", title: "Gain", minimum: 0, default: 3 },
          takes: {
            type: "array",
            title: "Takes",
            items: {
              type: "object",
              title: "take",
              properties: {
                file: text("File", { reload: { path: "file" } }),
                markers: {
                  type: "array",
                  title: "Markers",
                  items: {
                    type: "object",
                    title: "marker",
                    properties: { at: { type: "number", title: "At" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

beforeAll(() => {
  window.RED = { notify: () => undefined };
  const form = document.createElement("div");
  form.className = "reload-form";
  form.setAttribute("data-reload-type", TYPE);
  document.body.append(form);
  window.ReloadForms?.define(TYPE, SCHEMA);
});

function forms(): NonNullable<Window["ReloadForms"]> {
  const loaded = window.ReloadForms;
  if (loaded === undefined) throw new Error("the form code did not load");
  return loaded;
}

function opened(node: Record<string, unknown>): HTMLElement {
  forms().prepare(TYPE, node);
  const form = document.querySelector<HTMLElement>(`.reload-form[data-reload-type="${TYPE}"]`);
  if (form === null) throw new Error("no form");
  return form;
}

/** The rows drawn directly in the table at `path`. */
const rowsOf = (form: Element, path: string): HTMLElement[] => {
  const table = form.querySelector(`[data-reload-table="${path}"]`);
  return [...(table?.children ?? [])].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute("data-reload-row"),
  );
};

/** The control of `line` itself (never a nested row's) for `action`. */
function own(line: Element | null | undefined, action: string): HTMLButtonElement {
  const found = [...(line?.children ?? [])].find(
    (child) => child.getAttribute("data-reload-action") === action,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${action}`);
  return found;
}

/** The columns of `line` a person sees: each field row of its own not folded away. */
const seen = (line: Element): string[] =>
  [...line.children]
    .filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.hasAttribute("data-reload-key"),
    )
    .filter((child) => child.style.display !== "none")
    .map((child) => child.getAttribute("data-reload-key") ?? "");

const field = (form: Element, path: string): HTMLInputElement => {
  const found = form.querySelector<HTMLInputElement>(`[data-reload-field="${path}"]`);
  if (found === null) throw new Error(`no field ${path}`);
  return found;
};

const recorder = (name: string, more: Record<string, unknown> = {}) => ({
  name,
  language: "nl",
  gain: 3,
  ...more,
});

describe("a table of the canvas form", () => {
  it("says what the package calls a row on its Add, and a new row holds each column's default", () => {
    const form = opened({ id: "t1", volumes: [recorder("Zoom H6")] });
    const add = own(form.querySelector("[data-reload-table='volumes']"), "add");
    expect(add.textContent).toBe("Add recorder");
    add.click();
    expect(rowsOf(form, "volumes")).toHaveLength(2);
    expect(field(form, "volumes.1.name").value).toBe("New recorder");
    expect(field(form, "volumes.1.gain").value).toBe("3");
    expect(
      own(form.querySelector("[data-reload-table='volumes.0.takes']"), "add").textContent,
    ).toBe("Add take");
  });

  it("asks on the row before removing one that holds something, and removes it once answered", () => {
    const form = opened({ id: "t2", volumes: [recorder("Zoom H6"), recorder("Field recorder")] });
    // Before anybody asked, there is nothing to confirm: no removal goes unasked.
    expect(form.querySelector("[data-reload-action='remove-now']")).toBeNull();
    const [first] = rowsOf(form, "volumes");
    own(first, "remove").click();
    expect(rowsOf(form, "volumes")).toHaveLength(2);
    const question = first?.querySelector("[data-reload-question]");
    expect(question?.textContent).toContain("recorder 1 holds values. Remove it?");
    expect(own(question, "keep").textContent).toBe(TABLE_WORDS.keep);
    own(question, "remove-now").click();
    expect(rowsOf(form, "volumes")).toHaveLength(1);
    expect(field(form, "volumes.0.name").value).toBe("Field recorder");
    expect(form.querySelector("[data-reload-question]")).toBeNull();
  });

  it("puts the question away when the row is kept, and changes nothing else", () => {
    const form = opened({ id: "t3", volumes: [recorder("Zoom H6")] });
    const [first] = rowsOf(form, "volumes");
    own(first, "remove").click();
    own(first?.querySelector("[data-reload-question]"), "keep").click();
    expect(form.querySelector("[data-reload-question]")).toBeNull();
    expect(rowsOf(form, "volumes")).toHaveLength(1);
    expect(field(form, "volumes.0.name").value).toBe("Zoom H6");
  });

  it("removes an empty row at once, and never counts a row holding a nested row as empty", () => {
    const form = opened({ id: "t4", volumes: [{}, { takes: [{ file: "/one.wav" }] }] });
    for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "[data-reload-row='volumes.0'] [data-reload-field]",
    )) {
      input.value = "";
    }
    own(rowsOf(form, "volumes")[0], "remove").click();
    expect(rowsOf(form, "volumes")).toHaveLength(1);
    own(rowsOf(form, "volumes")[0], "remove").click();
    expect(rowsOf(form, "volumes")).toHaveLength(1);
    expect(holdsSomething({ name: "", takes: [{ file: "/one.wav" }] })).toBe(true);
    expect(holdsSomething({ name: "", gain: undefined, takes: [], on: false })).toBe(false);
  });

  it("draws a wide row's first columns until its More is used, and reads every column back", () => {
    const form = opened({ id: "t5", volumes: [recorder("Zoom H6", { volume_uuid: "8A1F" })] });
    const [line] = rowsOf(form, "volumes");
    if (line === undefined) throw new Error("no row");
    expect(seen(line)).toEqual(["name", "volume_uuid", "volume_name"].slice(0, SHOWN_COLUMNS));
    const more = own(line, "more");
    expect(more.textContent).toBe("More (3)");
    more.click();
    expect(seen(line)).toEqual(["name", "volume_uuid", "volume_name", "language", "gain", "takes"]);
    expect(more.textContent).toBe(TABLE_WORDS.fewer);
    more.click();
    expect(seen(line)).toHaveLength(SHOWN_COLUMNS);
    const node: Record<string, unknown> = {
      id: "t5",
      volumes: [recorder("Zoom H6", { volume_uuid: "8A1F" })],
    };
    opened(node);
    field(document.body, "volumes.0.gain").value = "7";
    forms().save(TYPE, node);
    expect(node["volumes"]).toEqual([
      {
        name: "Zoom H6",
        volume_uuid: "8A1F",
        volume_name: "",
        language: "nl",
        gain: "7",
        takes: [],
      },
    ]);
  });

  it("draws a table in a row under that row, deeper, collapsing to its rows' first column", () => {
    const form = opened({
      id: "t6",
      volumes: [
        recorder("Zoom H6", { takes: [{ file: "/one.wav", markers: [{ at: 1.5 }, { at: 9 }] }] }),
      ],
    });
    const takes = form.querySelector<HTMLElement>("[data-reload-table='volumes.0.takes']");
    expect(takes?.closest("[data-reload-row]")?.getAttribute("data-reload-row")).toBe("volumes.0");
    expect(takes?.style.marginLeft).toBe("16px");
    const markers = form.querySelector("[data-reload-table='volumes.0.takes.0.markers']");
    expect(markers?.closest("[data-reload-row]")?.getAttribute("data-reload-row")).toBe(
      "volumes.0.takes.0",
    );
    expect(rowsOf(form, "volumes.0.takes.0.markers")).toHaveLength(2);
    // The top table is no column of a row, so it does not fold.
    expect(
      [...(form.querySelector("[data-reload-table='volumes']")?.children ?? [])].some(
        (child) => child.getAttribute("data-reload-action") === "fold",
      ),
    ).toBe(false);
    const fold = own(takes, "fold");
    expect(fold.textContent).toBe(TABLE_WORDS.collapse);
    fold.click();
    const [take] = rowsOf(form, "volumes.0.takes");
    if (take === undefined) throw new Error("no take");
    expect(seen(take)).toEqual(["file"]);
    expect(fold.textContent).toBe(TABLE_WORDS.expand);
    fold.click();
    expect(seen(take)).toEqual(["file", "markers"]);
  });

  it("refuses each row repeating another's unique value, naming the other, and saves the row that repeats nothing", () => {
    const node: Record<string, unknown> = { id: "t7", volumes: [] };
    const form = opened(node);
    const add = own(form.querySelector("[data-reload-table='volumes']"), "add");
    add.click();
    add.click();
    own(form.querySelector("[data-reload-table='volumes']"), "add").click();
    field(form, "volumes.0.name").value = "Zoom H6";
    field(form, "volumes.1.name").value = "Field recorder";
    field(form, "volumes.2.name").value = "Zoom H6";
    forms().save(TYPE, node);
    expect((node["volumes"] as { name: string }[]).map((row) => row.name)).toEqual([
      "Field recorder",
    ]);
    const clashes = uniqueClashes(SCHEMA, {
      volumes: [{ name: "Zoom H6" }, { name: "Field recorder" }, { name: "Zoom H6" }],
    });
    expect(clashes).toEqual([
      {
        path: "/volumes/0/name",
        message: '"Zoom H6" is also in recorder 3: each must be different',
      },
      {
        path: "/volumes/2/name",
        message: '"Zoom H6" is also in recorder 1: each must be different',
      },
    ]);
  });

  it("compares a row that leaves its unique column empty with nobody, at any depth", () => {
    expect(
      uniqueClashes(SCHEMA, { volumes: [{ volume_uuid: "a" }, { volume_uuid: "b", name: "" }] }),
    ).toEqual([]);
    const nested = {
      type: "object",
      properties: {
        group: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { n: { type: "number", reload: { unique: true } } },
              },
            },
          },
        },
      },
    };
    expect(uniqueClashes(nested, { group: { rows: [{ n: 1 }, { n: 1 }, "x"] } })).toEqual([
      { path: "/group/rows/0/n", message: '"1" is also in row 2: each must be different' },
      { path: "/group/rows/1/n", message: '"1" is also in row 1: each must be different' },
    ]);
    expect(uniqueClashes(nested, "x")).toEqual([]);
  });
});
