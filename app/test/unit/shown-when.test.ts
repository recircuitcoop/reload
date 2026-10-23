// @vitest-environment happy-dom
//
// `reload.shown` (plan 0032, group 2): a setting drawn only while another setting of the same
// object holds a value, as the old `shown_when` (tests/test_addon_settings.py,
// test_settings_form.py, test_plugin_page.py, test_table_declaration.py). Declared and judged
// when the package is read; followed by the canvas form as the person types, and by Setup; the
// hidden field keeps its value. One rule decides, strictly: a number 1 is not a switch that is on.

import { beforeAll, describe, expect, it } from "vitest";

import "../../src/adapters/nodered/editor-forms";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { formModel, hiddenKeys } from "../../src/domain/forms/form-model";
import { parseDeclaration } from "../../src/domain/packages/declaration";
import { draftOf, hiddenOf, setupFields } from "../../src/ui/setup-form";

const validator = new AjvSchemaValidator();

const problemsOf = (properties: Record<string, unknown>): readonly string[] => {
  const parsed = parseDeclaration(
    {
      protocol: 2,
      package: "monty",
      version: "0.1.0",
      types: [
        {
          id: "watch",
          kind: "node",
          label: "Watch",
          command: ["{package}/watch.py"],
          config: { type: "object", properties },
          outputs: [],
        },
      ],
    },
    validator,
  );
  return parsed.ok ? [] : parsed.problems;
};

const WATCHING = { type: "boolean", title: "Watch on start" };
const shownWhen = (when: string, equals: unknown, more: Record<string, unknown> = {}) => ({
  type: "string",
  title: "Folder",
  reload: { shown: { when, equals } },
  ...more,
});
const table = (columns: Record<string, unknown>) => ({
  type: "array",
  title: "Recorders",
  items: { type: "object", title: "recorder", properties: columns },
});
const AT = "types/0/config/properties";

describe("a condition, declared", () => {
  it("parses naming another field, in either order, at the top and in a row", () => {
    expect(problemsOf({ watching: WATCHING, folder: shownWhen("watching", true) })).toEqual([]);
    expect(problemsOf({ folder: shownWhen("watching", true), watching: WATCHING })).toEqual([]);
    const row = { watching: WATCHING, destination: shownWhen("watching", true) };
    expect(problemsOf({ volumes: table(row) })).toEqual([]);
    const [, folder] = formModel({
      properties: { watching: WATCHING, folder: shownWhen("watching", true) },
    }).fields;
    expect(folder?.shown).toEqual({ when: "watching", equals: true });
    expect(formModel({ properties: { watching: WATCHING } }).fields[0]?.shown).toBeUndefined();
  });

  it("is refused naming itself, or a field outside its own group or row, naming both", () => {
    expect(problemsOf({ volumes: table({ label: shownWhen("label", "x") }) })).toEqual([
      `${AT}/volumes/items/properties/label/reload/shown/when: "label" is this property itself`,
    ]);
    const beside = (when: string, key: string) =>
      `"${when}" is not a property beside "${key}": a condition names a property of the same group or row`;
    // A field of the enclosing form.
    expect(
      problemsOf({ watching: WATCHING, volumes: table({ label: shownWhen("watching", true) }) }),
    ).toEqual([
      `${AT}/volumes/items/properties/label/reload/shown/when: ${beside("watching", "label")}`,
    ]);
    // A field of a sibling table's row.
    expect(
      problemsOf({
        folders: table({ watching: WATCHING }),
        volumes: table({ label: shownWhen("watching", true) }),
      }),
    ).toEqual([
      `${AT}/volumes/items/properties/label/reload/shown/when: ${beside("watching", "label")}`,
    ]);
    // A field of the row that holds this row's table.
    const takes = table({ label: shownWhen("watching", true) });
    expect(problemsOf({ volumes: table({ watching: WATCHING, takes }) })).toEqual([
      `${AT}/volumes/items/properties/takes/items/properties/label/reload/shown/when: ${beside("watching", "label")}`,
    ]);
    // Nothing of that name at all.
    expect(problemsOf({ folder: shownWhen("watching", true) })).toEqual([
      `${AT}/folder/reload/shown/when: ${beside("watching", "folder")}`,
    ]);
  });

  it("is refused waiting for a value its field can never hold, or missing its field or value", () => {
    expect(problemsOf({ watching: WATCHING, folder: shownWhen("watching", "yes") })).toEqual([
      `${AT}/folder/reload/shown/equals: "yes" is not a value "watching" can hold`,
    ]);
    expect(
      problemsOf({
        watching: WATCHING,
        folder: text({ reload: { shown: { when: "watching" } } }),
      }).join(),
    ).toContain(`${AT}/folder/reload/shown/equals: is required`);
    expect(
      problemsOf({ watching: WATCHING, folder: shownWhen("watching", ["a"]) }).join(),
    ).toContain(`${AT}/folder/reload/shown/equals: must be string,number,boolean`);
  });
});

function text(more: Record<string, unknown>): Record<string, unknown> {
  return { type: "string", title: "Folder", ...more };
}

describe("a condition, judged", () => {
  const { fields } = formModel({
    properties: {
      interval: { type: "integer", title: "Interval", default: 1 },
      quality: shownWhen("interval", true, { title: "Quality" }),
      depth: shownWhen("mode", "advanced", { title: "Depth" }),
      mode: { type: "string", title: "Mode", enum: ["simple", "advanced"], default: "simple" },
      watching: WATCHING,
      folder: shownWhen("watching", true),
    },
  });

  it("is not met by a value of another type", () => {
    expect(hiddenKeys(fields, {}).has("quality")).toBe(true);
    expect(hiddenKeys(fields, { interval: "1" }).has("quality")).toBe(true);
  });

  it("may name a field declared after it, and meets that field's default", () => {
    expect(hiddenKeys(fields, {}).has("depth")).toBe(true);
    expect(hiddenKeys(fields, { mode: "advanced" }).has("depth")).toBe(false);
  });

  it("follows the field it names, each way, and the named field is always drawn", () => {
    expect([...hiddenKeys(fields, {})].sort()).toEqual(["depth", "folder", "quality"]);
    expect(hiddenKeys(fields, { watching: true }).has("folder")).toBe(false);
    expect(hiddenKeys(fields, { watching: "true" }).has("folder")).toBe(false);
    expect(hiddenKeys(fields, { watching: false }).has("folder")).toBe(true);
    expect(hiddenKeys(fields, { watching: true }).has("watching")).toBe(false);
  });

  it("is judged the same way by Setup as by the canvas form, so one rule decides", () => {
    const schema = {
      properties: {
        mode: { type: "string", title: "Mode", enum: ["simple", "advanced"], default: "simple" },
        depth: shownWhen("mode", "advanced", { title: "Depth" }),
        count: { type: "integer", title: "Count" },
        many: shownWhen("count", 2, { title: "Many" }),
        watching: WATCHING,
        folder: shownWhen("watching", true),
      },
    };
    const setup = setupFields(schema);
    const canvas = formModel(schema).fields;
    const cases: Record<string, unknown>[] = [
      {},
      { mode: "advanced" },
      { mode: "simple", count: 2 },
      { count: 3, watching: true },
      { watching: false, mode: "advanced", count: 2 },
    ];
    for (const values of cases) {
      const drawn = draftOf(setup, values);
      expect([...hiddenOf(setup, drawn)].sort()).toEqual([...hiddenKeys(canvas, values)].sort());
    }
  });
});

describe("a condition, in the canvas form", () => {
  const TYPE = "reload-demo-conditions";
  beforeAll(() => {
    const form = document.createElement("div");
    form.className = "reload-form";
    form.setAttribute("data-reload-type", TYPE);
    document.body.append(form);
    window.ReloadForms?.define(TYPE, {
      type: "object",
      properties: {
        mode: { type: "string", title: "Mode", enum: ["simple", "advanced"], default: "simple" },
        depth: {
          type: "integer",
          title: "Depth",
          reload: { shown: { when: "mode", equals: "advanced" } },
        },
        volumes: table({ watching: WATCHING, destination: shownWhen("watching", true) }),
      },
    });
  });

  const rowOf = (form: Element, path: string): HTMLElement => {
    const control = form.querySelector(`[data-reload-field="${path}"]`);
    const row = control?.closest<HTMLElement>("[data-reload-key]");
    if (row == null) throw new Error(`no row for ${path}`);
    return row;
  };

  it("draws a dependent field only while its field holds the value, following each change, in a row too", () => {
    const forms = window.ReloadForms;
    if (forms === undefined) throw new Error("the form code did not load");
    const node: Record<string, unknown> = {
      id: "c1",
      mode: "simple",
      depth: 3,
      volumes: [{ watching: false, destination: "/kept" }],
    };
    forms.prepare(TYPE, node);
    const form = document.querySelector(`.reload-form[data-reload-type="${TYPE}"]`) as HTMLElement;
    expect(rowOf(form, "depth").hidden).toBe(true);
    const mode = form.querySelector<HTMLSelectElement>('[data-reload-field="mode"]');
    if (mode === null) throw new Error("no mode");
    mode.value = "advanced";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(rowOf(form, "depth").hidden).toBe(false);
    mode.value = "simple";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(rowOf(form, "depth").hidden).toBe(true);
    expect(rowOf(form, "volumes.0.destination").hidden).toBe(true);
    const watching = form.querySelector<HTMLInputElement>(
      '[data-reload-field="volumes.0.watching"]',
    );
    if (watching === null) throw new Error("no switch");
    watching.checked = true;
    watching.dispatchEvent(new Event("change", { bubbles: true }));
    expect(rowOf(form, "volumes.0.destination").hidden).toBe(false);
    // A hidden field is still saved with the value it holds.
    watching.checked = false;
    watching.dispatchEvent(new Event("change", { bubbles: true }));
    forms.save(TYPE, node);
    expect(node["depth"]).toBe("3");
    expect(node["volumes"]).toEqual([{ watching: false, destination: "/kept" }]);
  });
});
