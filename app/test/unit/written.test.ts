// domain/forms/written.ts: a node writing its own settings (spec 4.6, revision 2.2; plan 0032,
// WI-0032-41), as the old settings store let a plugin record a value and said who set it, and
// when (tests/test_settings_store.py, test_table_store.py, test_settings_form.py).

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { formModel } from "../../src/domain/forms/form-model";
import { isReadOnly } from "../../src/domain/forms/reload-keyword";
import {
  attributionOf,
  judgeWrite,
  NO_RECORD,
  personRefusals,
  personStamp,
  personWrites,
  recorded,
  stamped,
  USER,
  withWritten,
  WRITTEN_KEY,
  writtenByOf,
} from "../../src/domain/forms/written";
import { parseDeclaration } from "../../src/domain/packages/declaration";

const validator = new AjvSchemaValidator();
const check = validator.check.bind(validator);

const SCHEMA = {
  type: "object",
  properties: {
    interval: { type: "integer", title: "Interval", minimum: 1 },
    shared: { type: "integer", title: "Shared", reload: { writtenBy: "both" } },
    found: { type: "string", title: "Found", reload: { writtenBy: "plugin" } },
    token: { type: "string", title: "Token", writeOnly: true, reload: { writtenBy: "plugin" } },
    volumes: {
      type: "array",
      title: "Recorders",
      reload: { writtenBy: "both" },
      items: {
        type: "object",
        title: "recorder",
        properties: {
          label: { type: "string", title: "Name" },
          takes: {
            type: "array",
            title: "Takes",
            items: {
              type: "object",
              title: "take",
              properties: { file: { type: "string", title: "F" } },
            },
          },
          extra: { type: "object", title: "Extra", additionalProperties: true, properties: {} },
        },
      },
    },
    open: {
      type: "array",
      title: "Open",
      reload: { writtenBy: "both" },
      items: {
        type: "object",
        title: "o",
        additionalProperties: { type: "string" },
        properties: {},
      },
    },
  },
};
const write = (values: Record<string, unknown>, by?: unknown) =>
  judgeWrite(SCHEMA, values, "monty", by, check);

describe("a node's write of its own settings, judged", () => {
  it("records a property its package may set, alone or as either, and refuses one left to the person", () => {
    const { accepted, outcome } = write({ found: "/x", shared: 30, interval: 20 });
    expect(accepted).toEqual({ found: "/x", shared: 30 });
    expect(outcome).toEqual({
      recorded: ["found", "shared"],
      refused: [
        { path: "/interval", message: "is left to the person: its package may not set it" },
      ],
    });
    expect([writtenByOf(SCHEMA.properties.found), writtenByOf(SCHEMA.properties.shared)]).toEqual([
      "plugin",
      "both",
    ]);
    expect(writtenByOf(SCHEMA.properties.interval)).toBeNull();
    expect(writtenByOf({ reload: { writtenBy: "anyone" } })).toBeNull();
  });

  it("refuses a write in another package's name whole, and records nothing of it", () => {
    expect(write({ shared: 20 }, "whodunnit")).toEqual({
      accepted: {},
      outcome: {
        recorded: [],
        refused: [
          {
            path: "",
            message:
              'is a write in the name of "whodunnit": package monty writes only its own settings',
          },
        ],
      },
    });
    expect(write({ shared: 20 }, "monty").outcome.recorded).toEqual(["shared"]);
  });

  it("judges each value by its own schema, and refuses a row holding a key its row does not declare", () => {
    expect(write({ shared: "x", nope: 1 }).outcome.refused).toEqual([
      { path: "/shared", message: "must be integer" },
      { path: "/nope", message: "is not a declared property" },
    ]);
    const rows = [
      { label: "Zoom H6" },
      { label: "Field recorder", colour: "red", takes: [{ file: "a", odd: 1 }] },
    ];
    expect(write({ volumes: rows }).outcome.refused).toEqual([
      { path: "/volumes/1", message: 'holds "colour", which its row does not declare' },
      { path: "/volumes/1/takes/0", message: 'holds "odd", which its row does not declare' },
    ]);
    // A row that lets other keys in, and a row that is not an object, are the schema's to judge.
    expect(write({ open: [{ any: "x" }] }).outcome.refused).toEqual([]);
    expect(write({ volumes: ["x"] }).outcome.refused).toEqual([
      { path: "/volumes/0", message: "must be object" },
    ]);
  });
});

describe("the record of who wrote what", () => {
  it("records each property once, however many rows, with its writer and time, its secret apart", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ label: `recorder ${String(n)}` }));
    const first = recorded(
      NO_RECORD,
      SCHEMA,
      { volumes: rows, token: "ya29" },
      "monty",
      "2026-10-23T10:00:00.000Z",
    );
    expect(first).toEqual({
      values: { volumes: rows },
      secrets: { token: "ya29" },
      written: {
        volumes: { by: "monty", at: "2026-10-23T10:00:00.000Z" },
        token: { by: "monty", at: "2026-10-23T10:00:00.000Z" },
      },
    });
    // A later write replaces only what it writes.
    const next = recorded(first, SCHEMA, { found: "/y" }, "monty", "2026-10-23T11:00:00.000Z");
    expect(next.values).toEqual({ volumes: rows, found: "/y" });
    expect(next.secrets).toEqual({ token: "ya29" });
    expect(Object.keys(next.written)).toEqual(["volumes", "token", "found"]);
  });

  it("says a write by the package is the package's, and the person's the person's, the later one winning", () => {
    const record = recorded(NO_RECORD, SCHEMA, { shared: 30 }, "monty", "2026-10-23T10:00:00.000Z");
    // The person typed it first: the package's later write is the one in force.
    const before = { shared: "2026-10-23T09:00:00.000Z", interval: "2026-10-23T09:00:00.000Z" };
    expect(attributionOf(record, before)).toEqual({
      shared: { by: "monty", at: "2026-10-23T10:00:00.000Z" },
      interval: { by: USER, at: "2026-10-23T09:00:00.000Z" },
    });
    expect(withWritten({ shared: 20 }, {}, record, before).config).toEqual({ shared: 30 });
    // The person changed it after: theirs is in force, and it is theirs.
    const after = { shared: "2026-10-23T12:00:00.000Z" };
    expect(attributionOf(record, after)["shared"]?.by).toBe(USER);
    expect(withWritten({ shared: 20 }, {}, record, after).config).toEqual({ shared: 20 });
    // A secret it wrote goes to the credentials, never the config.
    const secret = recorded(
      NO_RECORD,
      SCHEMA,
      { token: "ya29" },
      "monty",
      "2026-10-23T10:00:00.000Z",
    );
    expect(withWritten({}, { other: "o" }, secret, {})).toEqual({
      config: {},
      credentials: { other: "o", token: "ya29" },
    });
    // A record naming a property it holds no value for changes nothing.
    expect(
      withWritten(
        { a: 1 },
        {},
        { values: {}, secrets: {}, written: { b: { by: "monty", at: "x" } } },
        {},
      ).config,
    ).toEqual({ a: 1 });
  });

  it("stamps when the person changed each property, on the canvas and in Setup, and only what changed", () => {
    const at = "2026-10-23T12:00:00.000Z";
    expect(stamped({}, { interval: 1, shared: 2 }, { interval: 1, shared: 3 }, at)).toEqual({
      shared: at,
    });
    expect(stamped({ interval: "old" }, { interval: 1 }, { interval: 1 }, at)).toBeUndefined();
    const node = { id: "n", shared: 2, [WRITTEN_KEY]: { interval: "old", bad: 1 } };
    expect(personWrites(node)).toEqual({ interval: "old" });
    expect(personWrites({ [WRITTEN_KEY]: "nonsense" })).toEqual({});
    expect(personStamp(node, { shared: 3 }, at)).toEqual({
      [WRITTEN_KEY]: { interval: "old", shared: at },
    });
    expect(personStamp(node, { shared: 2 }, at)).toEqual({});
  });
});

describe("what the person may not set", () => {
  it("is a property only its package sets: drawn read-only, kept by a save, refused by Setup", () => {
    expect(isReadOnly(SCHEMA.properties.found)).toBe(true);
    expect(isReadOnly(SCHEMA.properties.shared)).toBe(false);
    expect(isReadOnly({ readOnly: true })).toBe(true);
    const fields = formModel(SCHEMA).fields;
    expect(fields.find((field) => field.key === "found")).toMatchObject({
      readOnly: true,
      writtenBy: "plugin",
    });
    expect(fields.find((field) => field.key === "shared")?.readOnly).toBeUndefined();
    expect(
      personRefusals(
        SCHEMA,
        { found: "/x", shared: 1, "account.token": "t", nope: 1 },
        new Set(["account.token"]),
      ),
    ).toEqual([
      { path: "/found", message: "is set by its package, never by the person" },
      { path: "/nope", message: "is not a declared property" },
    ]);
  });

  it("is declared only at the config's top level", () => {
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
            config: {
              type: "object",
              properties: {
                found: { type: "string", title: "Found", reload: { writtenBy: "plugin" } },
                group: {
                  type: "object",
                  title: "Group",
                  properties: {
                    inner: { type: "string", title: "Inner", reload: { writtenBy: "both" } },
                  },
                },
              },
            },
            outputs: [],
          },
        ],
      },
      validator,
    );
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      "types/0/config/properties/group/properties/inner/reload/writtenBy: only a property of the config's top level can be set by its package (spec 4.6)",
    ]);
  });
});
