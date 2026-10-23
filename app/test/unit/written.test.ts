// domain/forms/written.ts: a node writing its own settings (spec 4.6, revision 2.3; plan 0032,
// WI-0032-41), as the old settings store let a plugin record a value and said who set it, and
// when (tests/test_settings_store.py, test_table_store.py, test_settings_form.py).

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { formModel } from "../../src/domain/forms/form-model";
import { isReadOnly, writtenBy } from "../../src/domain/forms/reload-keyword";
import {
  attributionOf,
  judgeWrite,
  NO_RECORD,
  personRefusals,
  personStamp,
  personWrites,
  recorded,
  stampedAtDeploy,
  stamped,
  USER,
  withoutEcho,
  withWritten,
  WRITTEN_KEY,
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
    expect([writtenBy(SCHEMA.properties.found), writtenBy(SCHEMA.properties.shared)]).toEqual([
      "plugin",
      "both",
    ]);
    expect(writtenBy(SCHEMA.properties.interval)).toBeNull();
    expect(writtenBy({ reload: { writtenBy: "anyone" } })).toBeNull();
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
    expect(attributionOf(record, before, SCHEMA, "monty")).toEqual({
      shared: { by: "monty", at: "2026-10-23T10:00:00.000Z" },
      interval: { by: USER, at: "2026-10-23T09:00:00.000Z" },
    });
    expect(withWritten({ shared: 20 }, {}, record, before, SCHEMA, "monty").config).toEqual({
      shared: 30,
    });
    // The person changed it after: theirs is in force, and it is theirs.
    const after = { shared: "2026-10-23T12:00:00.000Z" };
    expect(attributionOf(record, after, SCHEMA, "monty")["shared"]?.by).toBe(USER);
    expect(withWritten({ shared: 20 }, {}, record, after, SCHEMA, "monty").config).toEqual({
      shared: 20,
    });
    // A secret it wrote goes to the credentials, never the config.
    const secret = recorded(
      NO_RECORD,
      SCHEMA,
      { token: "ya29" },
      "monty",
      "2026-10-23T10:00:00.000Z",
    );
    expect(withWritten({}, { other: "o" }, secret, {}, SCHEMA, "monty")).toEqual({
      config: {},
      credentials: { other: "o", token: "ya29" },
    });
    // A record naming a property it holds no value for changes nothing.
    expect(
      withWritten(
        { a: 1 },
        {},
        { values: {}, secrets: {}, written: { found: { by: "monty", at: "x" } } },
        {},
        SCHEMA,
        "monty",
      ).config,
    ).toEqual({ a: 1 });
  });

  it("merges only what the instance's own package wrote, of what the schema still lets it set", () => {
    const at = "2026-10-23T10:00:00.000Z";
    const record = {
      values: { found: "/theirs", interval: 5, shared: 30 },
      secrets: {},
      written: {
        // In another package's name, and before an update took the right away: never merged.
        found: { by: "whodunnit", at },
        interval: { by: "monty", at },
        shared: { by: "monty", at },
      },
    };
    expect(
      withWritten({ found: "/mine", interval: 1 }, {}, record, {}, SCHEMA, "monty").config,
    ).toEqual({
      found: "/mine",
      interval: 1,
      shared: 30,
    });
    expect(Object.keys(attributionOf(record, {}, SCHEMA, "monty"))).toEqual(["shared"]);
  });

  it("lets a secret the person gave later win over the one its package wrote", () => {
    const record = recorded(
      NO_RECORD,
      SCHEMA,
      { token: "ya29-theirs" },
      "monty",
      "2026-10-23T10:00:00.000Z",
    );
    const mine = { token: "2026-10-23T11:00:00.000Z" };
    expect(withWritten({}, { token: "mine" }, record, mine, SCHEMA, "monty").credentials).toEqual({
      token: "mine",
    });
    expect(withWritten({}, { token: "mine" }, record, {}, SCHEMA, "monty").credentials).toEqual({
      token: "ya29-theirs",
    });
  });

  it("lets the person's edit win from its deploy: written 10:00, edited 10:15, rewritten 10:20, deployed 10:30", () => {
    const declared = () => new Set(["shared"]);
    const first = recorded(NO_RECORD, SCHEMA, { shared: 30 }, "monty", "2026-10-23T10:00:00.000Z");
    const rewritten = recorded(first, SCHEMA, { shared: 31 }, "monty", "2026-10-23T10:20:00.000Z");
    // Edited at 10:15 on the canvas, Done, not deployed: no stamp yet. Deployed at 10:30.
    const deployed = [{ id: "n", type: "reload-monty-watch", shared: 20 }];
    const [node] = stampedAtDeploy(
      [{ id: "n", type: "reload-monty-watch", shared: 25 }],
      deployed,
      declared,
      "2026-10-23T10:30:00.000Z",
    ) as Record<string, unknown>[];
    const person = personWrites(node ?? {});
    expect(withWritten({ shared: 25 }, {}, rewritten, person, SCHEMA, "monty").config).toEqual({
      shared: 25,
    });
    // Had it been stamped at its Done (10:15), the package's 10:20 write would have won.
    const atDone = { shared: "2026-10-23T10:15:00.000Z" };
    expect(withWritten({ shared: 25 }, {}, rewritten, atDone, SCHEMA, "monty").config).toEqual({
      shared: 31,
    });
  });

  it("keeps the package's value in force, sent back unchanged, the node's own", () => {
    const at = "2026-10-23T10:00:00.000Z";
    const record = recorded(NO_RECORD, SCHEMA, { shared: 30 }, "monty", at);
    const node = { id: "n", shared: 20, [WRITTEN_KEY]: { shared: "2026-10-23T09:00:00.000Z" } };
    // Shown 30 (the package's), sent back 30: still the node's 20, so nothing is the person's.
    expect(withoutEcho({ shared: 30, interval: 4 }, node, record, SCHEMA, "monty")).toEqual({
      shared: 20,
      interval: 4,
    });
    // Changed by the person, it is theirs.
    expect(withoutEcho({ shared: 31 }, node, record, SCHEMA, "monty")).toEqual({ shared: 31 });
    // Echoed where the node holds none: left out.
    expect(withoutEcho({ shared: 30 }, { id: "n" }, record, SCHEMA, "monty")).toEqual({});
  });

  it("stamps a deploy's changes at the deploy: a value changed, a secret given, nothing else", () => {
    const declared = (type: string) =>
      type === "reload-monty-watch" ? new Set(["interval", "shared", "token"]) : null;
    const deployed = [
      {
        id: "n",
        type: "reload-monty-watch",
        interval: 1,
        shared: 2,
        [WRITTEN_KEY]: { interval: "old" },
      },
    ];
    const incoming = [
      {
        id: "n",
        type: "reload-monty-watch",
        interval: 1,
        shared: 3,
        credentials: { token: "new", other: "x" },
      },
      { id: "m", type: "reload-monty-watch", interval: 9 },
      { id: "o", type: "inject" },
      "not a node",
    ];
    const [stampedNode, fresh, other, odd] = stampedAtDeploy(
      incoming,
      deployed,
      declared,
      "2026-10-23T10:30:00.000Z",
    );
    expect((stampedNode as Record<string, unknown>)[WRITTEN_KEY]).toEqual({
      interval: "old",
      shared: "2026-10-23T10:30:00.000Z",
      token: "2026-10-23T10:30:00.000Z",
    });
    expect([fresh, other, odd]).toEqual(incoming.slice(1));
    // Unchanged, and a secret Node-RED kept as it was: nothing is stamped.
    const same = [{ ...deployed[0], credentials: { token: "__PWRD__" } }];
    expect(stampedAtDeploy(same, deployed, declared, "x")).toEqual(same);
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
