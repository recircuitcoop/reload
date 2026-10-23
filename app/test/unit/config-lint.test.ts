// domain/packages/config-lint.ts through parseDeclaration and the real ajv validator: a type's
// config refused when the package is read, at install, at load and by reload-pack, as the old
// manifest refused a broken settings declaration (tests/test_addon_settings.py,
// tests/test_table_declaration.py; plan 0032, group 26). Every refusal names its field: the
// person reading it is a package author looking for their own typo.

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { parseDeclaration } from "../../src/domain/packages/declaration";
import { duplicateKeyProblems, duplicateKeys } from "../../src/domain/packages/duplicate-keys";

const validator = new AjvSchemaValidator();

/** A declaration with one type whose config holds exactly `properties`. */
function declarationWith(properties: Record<string, unknown>): unknown {
  return {
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
  };
}

/** The problems of the config, or [] when it is accepted. */
const problemsOf = (properties: Record<string, unknown>): readonly string[] => {
  const parsed = parseDeclaration(declarationWith(properties), validator);
  return parsed.ok ? [] : parsed.problems;
};

/** One property that is accepted, so each case breaks exactly one thing. */
const text = (more: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "string",
  title: "Title",
  ...more,
});

/** A table of recorders whose row holds `columns`. */
const table = (columns: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  type: "array",
  title: "Recorders",
  items: { type: "object", title: "Recorder", properties: columns },
  ...more,
});

const AT = "types/0/config/properties";

/** The monty volume row the old plan wrote out in full. */
const MONTY_ROW = {
  label: text({ title: "Name", reload: { unique: true } }),
  volume_uuid: text({ title: "Volume UUID" }),
  globs: {
    type: "array",
    title: "Patterns",
    items: { type: "string" },
    default: ["WAV/**/*.WAV"],
  },
  language: { type: "string", title: "Language", enum: ["nl", "fr", "en"] },
};
const MONTY = table(MONTY_ROW, {
  items: { type: "object", title: "recorder", required: ["label"], properties: MONTY_ROW },
});

describe("a type's config, judged as the form draws it", () => {
  it("accepts one property of every control, each with its own constraints, at the top and in a row", () => {
    const every = {
      title: text(),
      notes: text({ title: "Notes", reload: { multiline: true } }),
      interval: { type: "number", title: "Interval", minimum: 1, maximum: 60, multipleOf: 5 },
      watching: { type: "boolean", title: "Watch on start" },
      quality: { type: "string", title: "Quality", enum: ["low", "high"] },
      formats: {
        type: "array",
        title: "Formats",
        uniqueItems: true,
        items: { enum: ["wav", "mp3"] },
        default: ["mp3"],
      },
      root: text({ title: "Root", reload: { path: "folder" } }),
      token: text({ title: "API token", writeOnly: true, description: "Pasted once" }),
      extra: {
        type: "array",
        title: "Extra files",
        items: { type: "string", reload: { path: "file" } },
      },
    };
    expect(problemsOf(every)).toEqual([]);
    expect(problemsOf({ volumes: table(every), monty: MONTY })).toEqual([]);
  });

  it("refuses a type outside JSON Schema's, at any depth, naming the property and the type", () => {
    for (const bad of ["widget", "Text", "", "list", "list of"]) {
      expect(problemsOf({ title: text({ type: bad }) })).toContain(
        `${AT}/title/type: must be one of "array", "boolean", "integer", "null", "number", ` +
          `"object", "string", not ${JSON.stringify(bad)}`,
      );
    }
    // A type that is not a name, the element type of a list, and a column of a row.
    expect(problemsOf({ title: text({ type: 1 }) }).join()).toContain(`${AT}/title/type:`);
    for (const bad of ["widget", "Text"]) {
      expect(problemsOf({ title: { type: "array", title: "T", items: { type: bad } } })).toContain(
        `${AT}/title/items/type: must be one of "array", "boolean", "integer", "null", "number", ` +
          `"object", "string", not ${JSON.stringify(bad)}`,
      );
      expect(problemsOf({ volumes: table({ label: text({ type: bad }) }) }).join()).toContain(
        `${AT}/volumes/items/properties/label/type:`,
      );
    }
    expect(problemsOf({ volumes: table({ label: text({ type: "" }) }) }).join()).toContain(
      `${AT}/volumes/items/properties/label/type:`,
    );
  });

  it("names the whole path to a typo three tables down", () => {
    const takes = table({ file: text({ type: "filepath", title: "File" }) }, { title: "Takes" });
    const recorders = table({ label: text(), takes }, { title: "Recorders" });
    const libraries = table({ name: text(), recorders }, { title: "Libraries" });
    expect(problemsOf({ libraries }).join()).toContain(
      `${AT}/libraries/items/properties/recorders/items/properties/takes/items/properties/` +
        `file/type: must be one of "array", "boolean", "integer", "null", "number", "object", ` +
        `"string", not "filepath"`,
    );
  });

  it("refuses a bound, a step, a label, a tip, a required list, options or a row of the wrong kind", () => {
    const wrong: [Record<string, unknown>, string][] = [
      [{ title: { type: "number", title: "N", minimum: "10" } }, `${AT}/title/minimum: must be number`],
      [{ title: { type: "number", title: "N", maximum: "10" } }, `${AT}/title/maximum: must be number`],
      [{ title: { type: "number", title: "N", multipleOf: "10" } }, `${AT}/title/multipleOf: must be number`],
      [{ title: { type: "number", title: "N", multipleOf: 0 } }, `${AT}/title/multipleOf: must be > 0`],
      [{ title: { type: "number", title: "N", multipleOf: -1 } }, `${AT}/title/multipleOf: must be > 0`],
      [{ title: text({ title: 1 }) }, `${AT}/title/title: must be string`],
      [{ title: text({ title: null }) }, `${AT}/title/title: must be string`],
      [{ title: text({ title: ["Title"] }) }, `${AT}/title/title: must be string`],
      [{ title: text({ description: 7 }) }, `${AT}/title/description: must be string`],
      [{ title: { type: "object", title: "G", required: "yes" } }, `${AT}/title/required: must be array`],
      [{ title: text({ required: true }) }, `${AT}/title/required: must be array`],
      [{ title: text({ enum: "low" }) }, `${AT}/title/enum: must be array`],
      [{ title: "title" }, `${AT}/title: must be object,boolean`],
      [{ volumes: table({}, { items: { type: "object", title: 1 } }) }, `${AT}/volumes/items/title: must be string`],
      [{ volumes: table({}, { items: { type: "object", title: null } }) }, `${AT}/volumes/items/title: must be string`],
      [{ volumes: table({}, { items: { type: "object", title: ["R"] } }) }, `${AT}/volumes/items/title: must be string`],
      [{ volumes: table({}, { items: { type: "object", title: "R", properties: "label" } }) }, `${AT}/volumes/items/properties: must be object`],
      [{ volumes: table({}, { items: { type: "object", title: "R", properties: 1 } }) }, `${AT}/volumes/items/properties: must be object`],
      [{ volumes: table({ id: "label" }) }, `${AT}/volumes/items/properties/id: must be object,boolean`],
    ]; // prettier-ignore
    for (const [properties, problem] of wrong) {
      expect(problemsOf(properties)).toContain(problem);
    }
    // A schema that is only `true` is valid JSON Schema, and still no field.
    expect(problemsOf({ title: true })).toContain(
      `${AT}/title: must be a schema object, as every drawn property is`,
    );
    // An optional tip and an optional required list are optional.
    expect(problemsOf({ title: text({ description: "What to call it" }) })).toEqual([]);
  });

  it("refuses a keyword the form does not know, naming it and its property, at the top and in a row", () => {
    expect(problemsOf({ title: text({ placeholder: "Type here" }) })).toEqual([
      `${AT}/title/placeholder: is not a JSON Schema keyword the form knows`,
    ]);
    expect(problemsOf({ volumes: table({ label: text({ placeholder: "Type here" }) }) })).toEqual([
      `${AT}/volumes/items/properties/label/placeholder: is not a JSON Schema keyword the form knows`,
    ]);
  });

  it("refuses a keyword that judges another type than the property's, naming both", () => {
    const misplaced: [Record<string, unknown>, string][] = [
      [text({ minimum: 1 }), `${AT}/title/minimum: applies to number or integer only, not to string`],
      [{ type: "boolean", title: "On", multipleOf: 1 }, `${AT}/title/multipleOf: applies to number or integer only, not to boolean`],
      [text({ enum: ["a"], reload: { path: "file" } }), `${AT}/title/reload/path: is never drawn on a list of options (enum)`],
      [text({ items: { type: "string" } }), `${AT}/title/items: applies to array only, not to string`],
      [{ type: "number", title: "N", minLength: 1 }, `${AT}/title/minLength: applies to string only, not to number`],
      [text({ properties: {} }), `${AT}/title/properties: applies to object only, not to string`],
    ]; // prettier-ignore
    for (const [property, problem] of misplaced) {
      expect(problemsOf({ title: property })).toEqual([problem]);
    }
    // A path's Browse… on a number is the declaration schema's refusal (spec 2.4.1).
    expect(problemsOf({ title: { type: "number", title: "N", reload: { path: "file" } } })).toEqual(
      [`${AT}/title/type: must be equal to constant`],
    );
  });

  it("refuses a property without a name, a title or a type, and a table without items, columns or a row noun", () => {
    expect(problemsOf({ "": text() })).toEqual([`${AT}/: a property needs a name`]);
    expect(problemsOf({ title: text({ title: "" }) })).toEqual([
      `${AT}/title/title: is the label the person reads: give the property a title`,
    ]);
    expect(problemsOf({ title: { type: "string" } })).toEqual([
      `${AT}/title/title: is the label the person reads: give the property a title`,
    ]);
    expect(problemsOf({ title: { title: "Title" } })).toEqual([
      `${AT}/title: declares no type, so the form cannot draw it: give it a type`,
    ]);
    expect(problemsOf({ volumes: table({ label: text(), globs: { title: "Patterns" } }) })).toEqual(
      [
        `${AT}/volumes/items/properties/globs: declares no type, so the form cannot draw it: give it a type`,
      ],
    );
    expect(problemsOf({ volumes: { type: "array", title: "Recorders" } })).toEqual([
      `${AT}/volumes: declares no items, so the form cannot draw its elements: give it items`,
    ]);
    expect(problemsOf({ volumes: table({ label: text() }, { items: { type: "object", properties: { label: text() } } }) })).toEqual([
      `${AT}/volumes/items/title: a table names its row (Add …): give its items a title`,
    ]); // prettier-ignore
    expect(problemsOf({ volumes: table({}) })).toEqual([
      `${AT}/volumes/items: a table's row declares no columns: give it properties`,
    ]);
    expect(
      problemsOf({ volumes: table({ label: text() }, { items: { type: "object", title: "", properties: { label: text() } } }) }),
    ).toEqual([`${AT}/volumes/items/title: a table names its row (Add …): give its items a title`]); // prettier-ignore
  });

  it("refuses a list of options that is empty, repeats one, holds an empty one, or one of another type", () => {
    const options = (choices: unknown): Record<string, unknown> => text({ enum: choices });
    expect(problemsOf({ title: options([]) })).toEqual([
      `${AT}/title/enum: offers no options: list at least one`,
    ]);
    // Pick several, and a list of picks, with no options.
    expect(problemsOf({ title: { type: "array", title: "T", uniqueItems: true, items: { enum: [] } } })).toEqual([
      `${AT}/title/items/enum: offers no options: list at least one`,
    ]); // prettier-ignore
    expect(problemsOf({ title: { type: "array", title: "T", items: { type: "string", enum: [] } } })).toEqual([
      `${AT}/title/items/enum: offers no options: list at least one`,
    ]); // prettier-ignore
    expect(problemsOf({ title: options(["low", "low"]) })).toEqual([
      `${AT}/title/enum/1: "low" is offered twice`,
    ]);
    expect(problemsOf({ title: options(["low", 2]) })).toEqual([
      `${AT}/title/enum/1: 2 does not fit the property's own type`,
    ]);
    expect(problemsOf({ title: options([""]) })).toEqual([
      `${AT}/title/enum/0: an empty option cannot be told from no choice`,
    ]);
  });

  it("refuses a bound above the one it must stay under", () => {
    expect(problemsOf({ title: { type: "number", title: "N", minimum: 10, maximum: 1 } })).toEqual([
      `${AT}/title/minimum: 10 is above maximum 1`,
    ]);
    expect(problemsOf({ title: text({ minLength: 3, maxLength: 2 }) })).toEqual([
      `${AT}/title/minLength: 3 is above maxLength 2`,
    ]);
    // Bounds below zero are bounds like any other.
    expect(
      problemsOf({ title: { type: "number", title: "N", minimum: -10, maximum: -1 } }),
    ).toEqual([]);
  });

  it("judges a default by its own schema, naming the default and the property", () => {
    const wrong: [Record<string, unknown>, unknown][] = [
      [text(), 1],
      [text({ reload: { multiline: true } }), true],
      [{ type: "number", title: "N" }, "5"],
      [{ type: "number", title: "N" }, true],
      [{ type: "boolean", title: "On" }, "yes"],
      [text({ writeOnly: true }), 1],
      [text({ reload: { path: "file" } }), 1],
      [{ type: "array", title: "T", items: { type: "string" } }, "one"],
      [{ type: "array", title: "T", uniqueItems: true, items: { enum: ["wav"] } }, "wav"],
      [text(), null],
    ];
    for (const [property, value] of wrong) {
      const [problem] = problemsOf({ title: { ...property, default: value } });
      expect(problem).toMatch(new RegExp(`^${AT}/title/default: default must be `));
    }
    const bounded = { type: "number", title: "N", minimum: 1, maximum: 10 };
    expect(problemsOf({ title: { ...bounded, default: 0 } })).toEqual([
      `${AT}/title/default: default must be >= 1`,
    ]);
    expect(problemsOf({ title: { ...bounded, default: 11 } })).toEqual([
      `${AT}/title/default: default must be <= 10`,
    ]);
    expect(problemsOf({ title: text({ enum: ["low", "high"], default: "medium" }) })).toEqual([
      `${AT}/title/default: default must be one of "low", "high", not "medium"`,
    ]);
    const formats = { type: "array", title: "F", uniqueItems: true, items: { enum: ["wav"] } };
    expect(problemsOf({ title: { ...formats, default: ["wav", "wav"] } })).toEqual([
      `${AT}/title/default: default must NOT have duplicate items (items ## 0 and 1 are identical)`,
    ]);
    const numbers = { type: "array", title: "N", items: { type: "number", minimum: 1 } };
    expect(problemsOf({ title: { ...numbers, default: [1, 0] } })).toEqual([
      `${AT}/title/default: default[1] must be >= 1`,
    ]);
    // A default of the property's own type is kept.
    expect(
      problemsOf({ title: text({ default: "hello" }), n: { ...bounded, default: 5 } }),
    ).toEqual([]);
  });

  it("judges a row's own column defaults, and a table's default rows by their row noun and place", () => {
    const counted = table({ label: { type: "number", title: "N", minimum: 1, default: 0 } });
    expect(problemsOf({ volumes: counted })).toEqual([
      `${AT}/volumes/items/properties/label/default: default must be >= 1`,
    ]);
    for (const value of ["Zoom H6", { label: "Zoom H6" }, 1]) {
      expect(problemsOf({ volumes: { ...MONTY, default: value } })).toEqual([
        `${AT}/volumes/default: default must be array`,
      ]);
    }
    expect(problemsOf({ volumes: { ...MONTY, default: [] } })).toEqual([
      `${AT}/volumes/default: a table that starts with no rows needs no default: leave it out`,
    ]);
    const rows = (...value: unknown[]) => problemsOf({ volumes: { ...MONTY, default: value } });
    expect(rows({ label: "Zoom H6" }, "Field recorder")).toEqual([
      `${AT}/volumes/default: default › recorder 2 must be object`,
    ]);
    expect(rows({ label: "Zoom H6" }, { label: "Field recorder", colour: "red" })).toEqual([
      `${AT}/volumes/default: default › recorder 2 › colour is not a declared property`,
    ]);
    expect(rows({ label: "Zoom H6" }, { volume_uuid: "8A1F-22C3" })).toEqual([
      `${AT}/volumes/default: default › recorder 2 › label is required`,
    ]);
    expect(rows({ label: "Zoom H6" }, { label: "Field recorder", language: "de" })).toEqual([
      `${AT}/volumes/default: default › recorder 2 › language must be one of "nl", "fr", "en", not "de"`,
    ]);
    // A required column with its own default may be left out of a default row.
    const filled = table({ label: text({ default: "Zoom H6" }) }, { default: [{}] });
    expect(problemsOf({ volumes: { ...filled, items: { ...filled.items, required: ["label"] } } })).toEqual(
      [],
    ); // prettier-ignore
    const takes = { ...table({ file: text({ title: "File" }) }, { title: "Takes" }) };
    takes.items = { ...takes.items, title: "take" };
    const nested = table({ label: text(), takes }, { default: [{ label: "Zoom H6", takes: [{ file: "/tmp/one.wav" }, { file: 1 }] }] }); // prettier-ignore
    nested.items = { ...nested.items, title: "recorder" };
    expect(problemsOf({ volumes: nested })).toEqual([
      `${AT}/volumes/default: default › recorder 1 › takes › take 2 › file must be string`,
    ]);
  });

  it("refuses a list of tables and a list of lists, which have no drawing", () => {
    const row = { type: "object", title: "Row", properties: { label: text() } };
    expect(problemsOf({ title: { type: "array", title: "T", items: { type: "array", items: row } } })).toEqual([
      `${AT}/title/items: a list of lists (or of tables) cannot be drawn`,
    ]); // prettier-ignore
    const lists = {
      type: "array",
      title: "T",
      items: { type: "array", items: { type: "string" } },
    };
    expect(problemsOf({ title: lists })).toEqual([
      `${AT}/title/items: a list of lists (or of tables) cannot be drawn`,
    ]);
  });

  it("finds a key a declaration repeats in one object, at any depth, and nowhere else", () => {
    const text_ =
      '{"types": [{"config": {"properties": {"folder": {"title": "A"}, "folder": {"title": "B"}}}}],' +
      ' "rows": {"items": {"properties": {"label": 1, "x": "a\\"b", "label": [true, null, -1.5e3]}}},' +
      ' "a": {"k": 1}, "b": {"k": 2}}';
    expect(duplicateKeys(text_)).toEqual([
      "/types/0/config/properties/folder",
      "/rows/items/properties/label",
    ]);
    expect(duplicateKeyProblems('{"a/b": {}, "a/b": {}}')).toEqual([
      "a~1b: is declared twice in one object, and JSON keeps only the last; give each its own name",
    ]);
    expect(duplicateKeys('[ {}, [], "x", {"a": {"a": 1}} ]')).toEqual([]);
  });
});
