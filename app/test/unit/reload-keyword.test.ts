// The `reload` annotation (spec 2.4.1, decision D9): one object per config property, read
// back for the form, accepted by strict validation, refused at the declaration when malformed,
// and never a change to what validates.
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import {
  isAdvanced,
  RELOAD_ANNOTATION,
  RELOAD_KEYWORD,
  reloadOptions,
} from "../../src/domain/forms/reload-keyword";
import { formModel } from "../../src/domain/forms/form-model";
import type { JsonSchema } from "../../src/domain/packages/declaration";

const SPACE = { type: "string", title: "Space", reload: { spaces: true } };
const TYPE = { type: "string", title: "Type", reload: { types: { of: "space" } } };
const CONFIG: JsonSchema = {
  type: "object",
  required: ["space"],
  properties: { space: SPACE, type: TYPE },
};

/** A declaration of one node type whose config schema is `config`. */
function declaration(config: unknown): unknown {
  return {
    protocol: 2,
    package: "optionsnode",
    version: "0.0.0",
    types: [
      {
        id: "pick",
        kind: "node",
        label: "Pick",
        command: ["{package}/node.py"],
        config,
        outputs: [],
      },
    ],
  };
}

describe("reloadOptions", () => {
  it("reads spaces and types-of-a-sibling", () => {
    expect(reloadOptions(SPACE)).toEqual({ source: "spaces" });
    expect(reloadOptions(TYPE)).toEqual({ source: "types", of: "space" });
  });

  it("reads nothing where nothing this revision defines is declared", () => {
    const cases: JsonSchema[] = [
      { type: "string" },
      { type: "integer", reload: { spaces: true } },
      { type: "string", reload: true },
      { type: "string", reload: { recorders: true } },
      { type: "string", reload: { spaces: false } },
      { type: "string", reload: { types: { of: "" } } },
      { type: "string", reload: { types: "space" } },
      { type: "string", reload: { spaces: true, types: { of: "space" } } },
    ];
    for (const property of cases) {
      expect(reloadOptions(property)).toBeNull();
    }
  });

  it("reads advanced on its own or beside options, and offers no options for it", () => {
    expect(isAdvanced({ type: "string", reload: { advanced: true } })).toBe(true);
    expect(isAdvanced({ type: "integer", reload: { advanced: true } })).toBe(true);
    expect(isAdvanced({ ...SPACE, reload: { spaces: true, advanced: true } })).toBe(true);
    expect(reloadOptions({ type: "string", reload: { spaces: true, advanced: true } })).toEqual({
      source: "spaces",
    });
    expect(reloadOptions({ type: "string", reload: { advanced: true } })).toBeNull();
    for (const property of [SPACE, { type: "string" }, { reload: { advanced: "yes" } }]) {
      expect(isAdvanced(property)).toBe(false);
    }
  });

  it("names the one keyword the annotation spends", () => {
    expect(RELOAD_KEYWORD).toBe("reload");
    expect(RELOAD_ANNOTATION).toEqual({ keyword: "reload" });
  });
});

describe("the form model", () => {
  it("keeps where a text field's options come from, the value still a plain string", () => {
    const [space, type] = formModel(CONFIG).fields;
    expect(space).toMatchObject({ key: "space", control: "text", reload: { source: "spaces" } });
    expect(type).toMatchObject({
      key: "type",
      control: "text",
      reload: { source: "types", of: "space" },
    });
    expect(formModel({ properties: { plain: { type: "string" } } }).fields[0]).not.toHaveProperty(
      "reload",
    );
  });

  it("marks an advanced field, and only that one", () => {
    const fields = formModel({
      properties: {
        space: SPACE,
        from: { type: "string", default: "/name", reload: { advanced: true } },
      },
    }).fields;
    expect(fields.map((field) => [field.key, field.advanced])).toEqual([
      ["space", undefined],
      ["from", true],
    ]);
    expect(fields[1]).not.toHaveProperty("reload");
  });
});

describe("validation with the annotation", () => {
  it("is accepted by a strict validator once registered, and refused before", () => {
    expect(() => new Ajv2020({ strict: true }).compile(CONFIG)).toThrow(/reload/);
    const strict = new Ajv2020({ strict: true }).addKeyword(RELOAD_ANNOTATION);
    expect(strict.compile(CONFIG)({ space: "s1", type: "t1" })).toBe(true);
  });

  it("never changes which values validate", () => {
    const validator = new AjvSchemaValidator();
    const bare: JsonSchema = {
      type: "object",
      required: ["space"],
      properties: { space: { type: "string" }, type: { type: "string" } },
    };
    const values: unknown[] = [
      { space: "s1", type: "t1" },
      { space: "s1" },
      {},
      { space: 5 },
      { space: "s1", type: ["t1"] },
    ];
    for (const value of values) {
      expect(validator.check(CONFIG, value)).toEqual(validator.check(bare, value));
    }
    expect(validator.check(CONFIG, { space: "s1", type: "t1" })).toEqual([]);
    expect(validator.check(CONFIG, { space: 5 })).not.toEqual([]);
  });
});

describe("the declaration schema", () => {
  const validator = new AjvSchemaValidator();

  it("accepts spaces and types-of on string properties", () => {
    expect(validator.declaration(declaration(CONFIG))).toEqual([]);
    expect(validator.declaration(declaration({ type: "object" }))).toEqual([]);
  });

  it("accepts advanced alone, on a property of any type, and beside spaces or types", () => {
    const config = {
      properties: {
        from: { type: "string", reload: { advanced: true } },
        limit: { type: "integer", reload: { advanced: true } },
        space: { ...SPACE, reload: { spaces: true, advanced: true } },
      },
    };
    expect(validator.declaration(declaration(config))).toEqual([]);
    const refused = { properties: { p: { type: "string", reload: { advanced: false } } } };
    expect(validator.declaration(declaration(refused)).map((problem) => problem.path)).toContain(
      "/types/0/config/properties/p/reload/advanced",
    );
  });

  it("leaves room for keys a later revision defines, beside the one it requires", () => {
    const later = {
      properties: { folder: { type: "string", reload: { spaces: true, folders: true } } },
    };
    expect(validator.declaration(declaration(later))).toEqual([]);
  });

  it("checks nested objects and table rows as it checks the top level", () => {
    const nested = {
      properties: {
        group: { type: "object", properties: { space: SPACE } },
        rows: { type: "array", items: { type: "object", properties: { type: TYPE } } },
      },
    };
    expect(validator.declaration(declaration(nested))).toEqual([]);
    const bad = { type: "integer", reload: { spaces: true } };
    const refused: [unknown, string][] = [
      [{ group: { type: "object", properties: { p: bad } } }, "/group/properties/p/type"],
      [
        { rows: { type: "array", items: { type: "object", properties: { p: bad } } } },
        "/rows/items/properties/p/type",
      ],
      [
        { g: { type: "object", properties: { h: { type: "object", properties: { p: bad } } } } },
        "/g/properties/h/properties/p/type",
      ],
    ];
    for (const [properties, path] of refused) {
      const problems = validator.declaration(declaration({ properties }));
      expect(problems.map((problem) => problem.path)).toContain(
        `/types/0/config/properties${path}`,
      );
    }
  });

  it("refuses a malformed annotation, naming the property", () => {
    const refused: [unknown, string][] = [
      [{ type: "integer", reload: { spaces: true } }, "/types/0/config/properties/p/type"],
      [{ reload: { spaces: true } }, "/types/0/config/properties/p/type"],
      [{ type: "string", reload: { spaces: "yes" } }, "/types/0/config/properties/p/reload/spaces"],
      [{ type: "string", reload: { types: {} } }, "/types/0/config/properties/p/reload/types/of"],
      [
        { type: "string", reload: { types: { of: "" } } },
        "/types/0/config/properties/p/reload/types/of",
      ],
      [{ type: "string", reload: "spaces" }, "/types/0/config/properties/p/reload"],
      [{ type: "string", reload: {} }, "/types/0/config/properties/p/reload/spaces"],
      [{ type: "string", reload: { folders: true } }, "/types/0/config/properties/p/reload"],
      [
        { type: "string", reload: { spaces: true, types: { of: "space" } } },
        "/types/0/config/properties/p/reload",
      ],
    ];
    for (const [property, path] of refused) {
      const problems = validator.declaration(declaration({ properties: { p: property } }));
      expect(problems.map((problem) => problem.path)).toContain(path);
    }
  });
});
