// @vitest-environment happy-dom
//
// adapters/nodered/editor-forms.ts in a DOM: as the canvas form opens, what is wrong with the
// node now is said beside what it is about: a field's reason after its control, a cell's
// beside that cell and nowhere else, a row's own on the row, and a table's own once above its
// rows (tests/test_table_drawing.py, test_table_form.py, test_settings_form.py; plan 0032,
// group 27). A required value left empty is caught, and a refused save's reason stays beside
// its field until a save corrects it.

import { beforeAll, describe, expect, it } from "vitest";

import "../../src/adapters/nodered/editor-forms";

const notices: string[] = [];

/** Each type's config, by its type name. */
const TYPES: Record<string, Record<string, unknown>> = {
  "reload-demo-settings": {
    type: "object",
    required: ["root"],
    properties: {
      interval: { type: "integer", title: "Interval", minimum: 30 },
      quality: { type: "string", title: "Quality", enum: ["low", "high"], default: "high" },
      root: { type: "string", title: "Root" },
      account: {
        type: "object",
        title: "Account",
        required: ["token"],
        properties: { token: { type: "string", title: "Token", writeOnly: true } },
      },
    },
  },
  "reload-demo-volumes": {
    type: "object",
    required: ["volumes"],
    properties: {
      volumes: {
        type: "array",
        title: "Recorders",
        items: {
          type: "object",
          title: "recorder",
          required: ["label"],
          additionalProperties: false,
          properties: {
            label: { type: "string", title: "Name" },
            gain: { type: "number", title: "Gain", minimum: 2 },
            takes: {
              type: "array",
              title: "Takes",
              items: {
                type: "object",
                title: "take",
                properties: {
                  file: { type: "string", title: "File" },
                  markers: {
                    type: "array",
                    title: "Markers",
                    items: {
                      type: "object",
                      title: "marker",
                      properties: { at: { type: "number", title: "At", minimum: 5 } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "reload-demo-minimum": {
    type: "object",
    properties: {
      volumes: {
        type: "array",
        title: "Recorders",
        maxItems: 1,
        items: {
          type: "object",
          title: "recorder",
          properties: { label: { type: "string", title: "Name" } },
        },
      },
    },
  },
  "reload-demo-takes": {
    type: "object",
    required: ["volumes"],
    properties: {
      volumes: {
        type: "array",
        title: "Recorders",
        items: {
          type: "object",
          title: "recorder",
          required: ["label", "takes"],
          properties: {
            label: { type: "string", title: "Name" },
            takes: {
              type: "array",
              title: "Takes",
              items: {
                type: "object",
                title: "take",
                properties: { file: { type: "string", title: "File" } },
              },
            },
          },
        },
      },
    },
  },
};

beforeAll(() => {
  window.RED = { notify: (message: string) => notices.push(message) };
  for (const [type, schema] of Object.entries(TYPES)) {
    const form = document.createElement("div");
    form.className = "reload-form";
    form.setAttribute("data-reload-type", type);
    document.body.append(form);
    window.ReloadForms?.define(type, schema);
  }
});

function forms(): NonNullable<Window["ReloadForms"]> {
  const loaded = window.ReloadForms;
  if (loaded === undefined) throw new Error("the form code did not load");
  return loaded;
}

/** The form of `type`, opened on `node`. */
function opened(type: string, node: Record<string, unknown>): HTMLElement {
  forms().prepare(type, node);
  const form = document.querySelector<HTMLElement>(`.reload-form[data-reload-type="${type}"]`);
  if (form === null) throw new Error(`no form for ${type}`);
  return form;
}

/** Every reason drawn in `form`, by the path it is drawn for. */
function reasons(form: Element): Record<string, string> {
  return Object.fromEntries(
    [...form.querySelectorAll("[data-testid^='reload-error-']")].map((said) => [
      (said.getAttribute("data-testid") ?? "").slice("reload-error-".length),
      said.textContent,
    ]),
  );
}

/** The row at `path` removed with its Remove, answering its question when it asks one. */
function removed(form: Element, path: string): void {
  const line = form.querySelector(`[data-reload-row='${path}']`);
  const press = (action: string) =>
    [...(line?.children ?? [])]
      .find((child) => child.getAttribute("data-reload-action") === action)
      ?.dispatchEvent(new Event("click"));
  press("remove");
  line?.querySelector<HTMLButtonElement>("[data-reload-action='remove-now']")?.click();
}

const field = (form: Element, path: string): HTMLInputElement => {
  const found = form.querySelector<HTMLInputElement>(`[data-reload-field="${path}"]`);
  if (found === null) throw new Error(`no field ${path}`);
  return found;
};

describe("the canvas form, as it opens", () => {
  it("draws each field with its value, its default, and its reason beside it", () => {
    const form = opened("reload-demo-settings", { id: "n1", interval: 20 });
    // A value its type no longer takes is shown as it is, with the reason; a field left to its
    // default shows the default; a required field never filled is said to be required.
    expect(field(form, "interval").value).toBe("20");
    expect(field(form, "quality").value).toBe("high");
    expect(field(form, "root").value).toBe("");
    const said = reasons(form);
    expect(said["interval"]).toContain("Interval");
    expect(said["interval"]).toContain("must be 30 or more");
    expect(said["quality"]).toBeUndefined();
    expect(said["root"]).toBe("Root: fill this in.");
    // The reason follows its control in the field's own row.
    const row = form.querySelector("[data-reload-key='interval']");
    expect(row?.lastElementChild?.getAttribute("data-testid")).toBe("reload-error-interval");
    expect(
      forms().validate("reload-demo-settings", { interval: 20, root: "x" }, "interval"),
    ).not.toBe(true);
  });

  it("catches a required text left empty, and a required secret in a group not set, on its field", () => {
    const node = {
      id: "n2",
      interval: 40,
      root: "",
      account: {},
      credentials: { "has_account.token": false },
    };
    const form = opened("reload-demo-settings", node);
    const said = reasons(form);
    expect(said["root"]).toBe("Root: fill this in.");
    expect(said["account.token"]).toContain("Token: fill this in.");
    expect(forms().validate("reload-demo-settings", node, "root")).toContain("Root: fill this in.");
    expect(forms().validate("reload-demo-settings", node, "account")).toContain(
      "Token: fill this in.",
    );
    // Filled and set, nothing is said.
    const ready = { ...node, root: "/x", credentials: { "has_account.token": true } };
    expect(reasons(opened("reload-demo-settings", ready))).toEqual({});
  });

  it("draws a cell's reason beside that cell and nowhere else, reachable by its row's place and column", () => {
    const form = opened("reload-demo-volumes", {
      id: "n3",
      volumes: [
        { label: "one", gain: 5 },
        { label: "two", gain: 1 },
      ],
    });
    const said = reasons(form);
    expect(Object.keys(said)).toEqual(["volumes.1.gain"]);
    expect(said["volumes.1.gain"]).toContain("Gain: must be 2 or more");
    // In the cell's own row of the second recorder, after its input; the value is still there.
    const cell = form.querySelector("[data-reload-row='volumes.1'] [data-reload-key='gain']");
    expect(cell?.lastElementChild?.getAttribute("data-testid")).toBe("reload-error-volumes.1.gain");
    expect(field(form, "volumes.1.gain").value).toBe("1");
  });

  it("addresses a missing required cell to that cell, and a cell three tables down by its whole path", () => {
    const missing = reasons(opened("reload-demo-volumes", { id: "n4", volumes: [{ gain: 5 }] }));
    expect(Object.keys(missing)).toEqual(["volumes.0.label"]);
    expect(missing["volumes.0.label"]).toContain("Name: fill this in.");
    const deep = opened("reload-demo-volumes", {
      id: "n5",
      volumes: [
        {
          label: "Zoom H6",
          takes: [
            { file: "/tmp/one.wav" },
            { file: "/tmp/two.wav", markers: [{ at: 1 }, { at: 9 }] },
          ],
        },
      ],
    });
    expect(Object.keys(reasons(deep))).toEqual(["volumes.0.takes.1.markers.0.at"]);
    // Every nested row is drawn, in its order, under the row that holds it.
    expect(field(deep, "volumes.0.takes.1.markers.1.at").value).toBe("9");
    expect(field(deep, "volumes.0.takes.0.file").value).toBe("/tmp/one.wav");
  });

  it("says a key its row does not take on the row itself, and a required table with no rows once above it", () => {
    const keyed = opened("reload-demo-volumes", {
      id: "n6",
      volumes: [{ label: "one", gain: 5, colour: "red" }],
    });
    const said = reasons(keyed);
    expect(Object.keys(said)).toEqual(["volumes.0"]);
    const row = keyed.querySelector("[data-reload-row='volumes.0']");
    expect(row?.querySelector("[data-testid='reload-error-volumes.0']")).not.toBeNull();
    expect(field(keyed, "volumes.0.label").value).toBe("one");
    const empty = opened("reload-demo-volumes", { id: "n7", volumes: [] });
    const above = empty.querySelectorAll("[data-testid='reload-error-volumes']");
    expect(above).toHaveLength(1);
    expect(above[0]?.textContent).toContain("is required and holds no recorder");
    // First in the table, before its rows and its Add, never after them.
    expect(above[0]?.parentElement?.getAttribute("data-reload-table")).toBe("volumes");
    expect(above[0]?.previousElementSibling).toBeNull();
  });

  it("reads a table back whole while its own reason is drawn above its rows", () => {
    const node: Record<string, unknown> = { id: "n10", volumes: [{ label: "a" }, { label: "b" }] };
    const form = opened("reload-demo-minimum", node);
    expect(reasons(form)["volumes"]).toContain("Recorders");
    // Read as an empty table, the save would pass maxItems and lose both rows.
    forms().save("reload-demo-minimum", node);
    expect(node["volumes"]).toEqual([{ label: "a" }, { label: "b" }]);
  });

  it("places the table's own reason and a cell's reason independently", () => {
    const form = opened("reload-demo-volumes", { id: "n8", volumes: [{ label: "one", gain: 0 }] });
    expect(Object.keys(reasons(form))).toEqual(["volumes.0.gain"]);
    expect(form.querySelector("[data-testid='reload-error-volumes']")).toBeNull();
  });

  it("keeps a refused save's reason beside its field until a save corrects it", () => {
    const node: Record<string, unknown> = { id: "n9", interval: 40, root: "/x" };
    let form = opened("reload-demo-settings", node);
    field(form, "interval").value = "3";
    forms().save("reload-demo-settings", node);
    expect(node["interval"]).toBe(40);
    form = opened("reload-demo-settings", node);
    expect(reasons(form)["interval"]).toContain("must be 30 or more");
    expect(field(form, "interval").value).toBe("3");
    field(form, "interval").value = "45";
    forms().save("reload-demo-settings", node);
    expect(node["interval"]).toBe("45");
    expect(reasons(opened("reload-demo-settings", node))["interval"]).toBeUndefined();
  });
});

describe("a save of a table with required values", () => {
  const TYPE = "reload-demo-takes";
  const row = (label: string, files: string[]) => ({
    label,
    takes: files.map((file) => ({ file })),
  });

  it("refuses only the row whose required cell is empty, or whose required table holds no row", () => {
    const node: Record<string, unknown> = {
      id: "s1",
      volumes: [row("Zoom H6", ["a.wav"]), row("F8n", ["b.wav"]), row("H4", ["c.wav"])],
    };
    const form = opened(TYPE, node);
    field(form, "volumes.1.label").value = "";
    // The third recorder's only take removed: it then holds no take.
    removed(form, "volumes.2.takes.0");
    forms().save(TYPE, node);
    // Each refused row keeps the row it was drawn from; the others are saved.
    expect(node["volumes"]).toEqual([
      row("Zoom H6", ["a.wav"]),
      row("F8n", ["b.wav"]),
      row("H4", ["c.wav"]),
    ]);
    const said = reasons(opened(TYPE, node));
    expect(Object.keys(said).sort()).toEqual(["volumes.1.label", "volumes.2.takes"]);
    expect(said["volumes.2.takes"]).toContain("is required and holds no take");
  });

  it("holds a required table whose every row is refused, or that a save empties, until one valid row is saved", () => {
    const node: Record<string, unknown> = { id: "s2", volumes: [] };
    expect(forms().validate(TYPE, node, "volumes")).toContain("is required and holds no recorder");
    let form = opened(TYPE, node);
    form.querySelector<HTMLButtonElement>("[data-reload-action='add']")?.click();
    forms().save(TYPE, node);
    // The added row is refused (no name, no take), so the table holds none: still held.
    expect(node["volumes"]).toEqual([]);
    expect(forms().validate(TYPE, node, "volumes")).not.toBe(true);
    node["volumes"] = [row("Zoom H6", ["a.wav"])];
    expect(forms().validate(TYPE, node, "volumes")).toBe(true);
    // Emptied by a save, the table is saved empty, and the node is held again.
    form = opened(TYPE, node);
    removed(form, "volumes.0");
    forms().save(TYPE, node);
    expect(node["volumes"]).toEqual([]);
    expect(forms().validate(TYPE, node, "volumes")).toContain("is required and holds no recorder");
  });
});
