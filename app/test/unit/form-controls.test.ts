// The old settings window's controls, as a config JSON Schema asks for them (plan 0032 group 1):
// a list of values, ticked options, several lines of text and a file or folder's path, each a
// control of its own in the form model, carrying what its input is built from; and a list that
// survives the form's round trip as a list (tests/test_addon_settings.py, test_plugin_page.py,
// test_settings_store.py, test_table_drawing.py).

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { coerceObject } from "../../src/domain/forms/coerce";
import { formModel, type Field } from "../../src/domain/forms/form-model";
import { isMultiline, pathKind } from "../../src/domain/forms/reload-keyword";
import type { JsonSchema } from "../../src/domain/packages/declaration";

const byKey = (fields: readonly Field[], key: string): Field => {
  const field = fields.find((f) => f.key === key);
  if (field === undefined) {
    throw new Error(`no field ${key}`);
  }
  return field;
};

/** One property of each control the old settings window drew (its nine types). */
const NINE: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", title: "Title" },
    notes: { type: "string", title: "Notes", reload: { multiline: true } },
    interval: { type: "integer", minimum: 1, maximum: 60, multipleOf: 5 },
    watching: { type: "boolean" },
    quality: { enum: ["low", "high"] },
    formats: { type: "array", items: { enum: ["wav", "mp3"] }, uniqueItems: true },
    root: { type: "string", reload: { path: "folder" } },
    token: { type: "string", writeOnly: true },
    "extra-files": { type: "array", items: { type: "string", reload: { path: "file" } } },
  },
};

describe("the controls of the old settings window", () => {
  it("one property of each of the nine types gets its own control, with its own constraints", () => {
    const { fields } = formModel(NINE);
    expect(fields.map((field) => field.control)).toEqual([
      "text",
      "textarea",
      "integer",
      "checkbox",
      "select",
      "multiselect",
      "path",
      "password",
      "list",
    ]);
    expect(byKey(fields, "interval")).toMatchObject({ min: 1, max: 60, step: 5 });
    expect(byKey(fields, "quality").options).toEqual(["low", "high"]);
    expect(byKey(fields, "formats").options).toEqual(["wav", "mp3"]);
    expect(byKey(fields, "root").pathKind).toBe("folder");
    // A list names its element's control separately, with the element's own constraints.
    expect(byKey(fields, "extra-files").element).toMatchObject({
      control: "path",
      pathKind: "file",
    });
    // Every other control carries no element, and no bound it does not declare.
    expect(byKey(fields, "title")).not.toHaveProperty("element");
    expect(byKey(fields, "watching")).not.toHaveProperty("min");
  });

  it("a list of each single-value type is a list, its element drawn with that type's control", () => {
    const elements: [JsonSchema, Field["control"]][] = [
      [{ type: "string" }, "text"],
      [{ type: "string", reload: { multiline: true } }, "textarea"],
      [{ type: "number", minimum: 1 }, "number"],
      [{ type: "boolean" }, "checkbox"],
      [{ enum: ["one", "two"] }, "select"],
      [{ type: "array", items: { enum: ["one", "two"] } }, "multiselect"],
      [{ type: "string", reload: { path: "file" } }, "path"],
    ];
    for (const [items, control] of elements) {
      const [many] = formModel({ properties: { many: { type: "array", items } } }).fields;
      // A list of options is ticked, not listed: the option is the element.
      const expected = control === "select" ? "multiselect" : "list";
      expect(many?.control).toBe(expected);
      if (expected === "list") {
        expect(many?.element?.control).toBe(control);
      }
    }
  });

  it("a multiselect's default is kept as the list it declares", () => {
    const [formats] = formModel({
      properties: {
        formats: { type: "array", items: { enum: ["wav", "mp3"] }, default: ["mp3"] },
      },
    }).fields;
    expect(formats).toMatchObject({ control: "multiselect", default: ["mp3"] });
  });

  it("a table's path column gets the path control a top-level path gets, kind and all", () => {
    const [volumes] = formModel({
      properties: {
        volumes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              destination: { type: "string", reload: { path: "folder" } },
            },
          },
        },
      },
    }).fields;
    expect(volumes?.control).toBe("table");
    expect(volumes?.fields?.map((column) => [column.key, column.control, column.pathKind])).toEqual(
      [
        ["name", "text", undefined],
        ["destination", "path", "folder"],
      ],
    );
  });

  it("an array with no items, or of tables, is typed as text for the validator to judge", () => {
    const { fields } = formModel({
      properties: {
        bare: { type: "array" },
        nested: { type: "array", items: { type: "array", items: { type: "object" } } },
      },
    });
    expect(fields.map((field) => field.control)).toEqual(["text", "text"]);
  });

  it("reads multiline and path only on a string, and only the kinds it defines", () => {
    expect(isMultiline({ type: "string", reload: { multiline: true } })).toBe(true);
    expect(isMultiline({ type: "integer", reload: { multiline: true } })).toBe(false);
    expect(isMultiline({ type: "string", reload: { advanced: true } })).toBe(false);
    expect(pathKind({ type: "string", reload: { path: "folder" } })).toBe("folder");
    expect(pathKind({ type: "string", reload: { path: "device" } })).toBeNull();
    expect(pathKind({ type: "number", reload: { path: "file" } })).toBeNull();
    expect(pathKind({ type: "string" })).toBeNull();
    // Options from Anytype win over either: the value is still chosen from them.
    const [space] = formModel({
      properties: { space: { type: "string", reload: { spaces: true, multiline: true } } },
    }).fields;
    expect(space?.control).toBe("text");
  });
});

describe("a list through the form", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      watching: { type: "boolean" },
      formats: { type: "array", items: { enum: ["wav", "mp3"] } },
      sizes: { type: "array", items: { type: "number", minimum: 1 } },
    },
  };

  it("a switch and a list survive a round trip as a switch and a list", () => {
    // As the editor reads them back: a list of number inputs is a list of texts.
    const drawn = { watching: true, formats: ["wav", "mp3"], sizes: ["2", "4.5"] };
    expect(coerceObject(schema, drawn)).toEqual({
      watching: true,
      formats: ["wav", "mp3"],
      sizes: [2, 4.5],
    });
  });

  it("a list whose elements break their constraint is refused, naming the element", () => {
    const validator = new AjvSchemaValidator();
    const drawn = coerceObject(schema, { sizes: ["2", "0"] });
    expect(validator.check(schema, drawn).map((problem) => problem.path)).toEqual(["/sizes/1"]);
  });
});
