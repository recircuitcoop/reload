// domain/forms/kept-on-save.ts: a save keeps what passes and nothing that fails, field by field
// and row by row, all the way down (plan 0032 group 28; the old store's rule, plan 0005 D2).
// The old tests (tests/test_settings_store.py, test_settings_form.py, test_table_store.py,
// test_table_form.py, test_plugin_tab.py) wrote to a settings file; here the "file" is the node's
// values before the save, and what is kept is what the editor puts back on the node.

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { coerceObject } from "../../src/domain/forms/coerce";
import { describedProblems } from "../../src/domain/forms/form-model";
import {
  droppedSentence,
  keptOnSave,
  notKeptSentence,
  readRefusal,
  storedRefusal,
  type RowOrigins,
} from "../../src/domain/forms/kept-on-save";
import type { JsonSchema } from "../../src/domain/packages/declaration";

const validator = new AjvSchemaValidator();

const INTERVAL = { type: "integer", title: "Interval", minimum: 1, maximum: 60 };
const QUALITY = { enum: ["low", "high"], title: "Quality" };
const MARKERS = {
  type: "array",
  title: "Markers",
  items: { type: "object", properties: { at: { type: "number", minimum: 0 } } },
};
const TAKES = {
  type: "array",
  title: "Takes",
  items: {
    type: "object",
    required: ["file"],
    properties: { file: { type: "string" }, markers: MARKERS },
  },
};

/** A table of recorders, as the old tests' `volumes()`; `more` adds columns. */
function volumes(more: Record<string, unknown> = {}): JsonSchema {
  return {
    type: "object",
    properties: {
      volumes: {
        type: "array",
        title: "Volumes",
        items: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string", title: "Label", minLength: 1 },
            volume_uuid: { type: "string" },
            destination: { type: "string" },
            ...more,
          },
        },
      },
    },
  };
}

const SETTINGS: JsonSchema = {
  type: "object",
  properties: { interval: INTERVAL, quality: QUALITY },
};

/**
 * The origins of a form whose rows nobody moved: each submitted row drawn from the stored row
 * at its place, when there is one, at every depth; a row past them added.
 */
function inPlace(schema: JsonSchema, previous: unknown, submitted: unknown, at = ""): RowOrigins {
  const origins = new Map<string, readonly (number | null)[]>();
  const record = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const [key, property] of Object.entries(record(schema["properties"]))) {
    const given = record(submitted)[key];
    const before = record(previous)[key];
    const items = record(record(property)["items"]);
    if (record(property)["type"] === "object") {
      for (const [path, rows] of inPlace(record(property), before, given, `${at}/${key}`)) {
        origins.set(path, rows);
      }
    }
    if (Array.isArray(given) && items["type"] === "object") {
      const stored = Array.isArray(before) ? before : [];
      origins.set(
        `${at}/${key}`,
        given.map((_, index) => (index < stored.length ? index : null)),
      );
      given.forEach((row, index) => {
        const nested = inPlace(items, stored[index], row, `${at}/${key}/${String(index)}`);
        for (const [path, rows] of nested) {
          origins.set(path, rows);
        }
      });
    }
  }
  return origins;
}

/** Save `submitted` over `previous`, judged as the editor judges it. */
function save(
  schema: JsonSchema,
  previous: Record<string, unknown>,
  submitted: Record<string, unknown>,
  origins: RowOrigins = inPlace(schema, previous, submitted),
) {
  const check = (value: Readonly<Record<string, unknown>>) => validator.check(schema, value);
  return keptOnSave(schema, previous, submitted, check, origins);
}

/** The rows a kept table holds. */
const rows = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[];

describe("a save, field by field", () => {
  it("a field that fails does not stop the fields that pass, and keeps its value before", () => {
    const kept = save(
      SETTINGS,
      { interval: 10, quality: "low" },
      { interval: "45", quality: "medium" },
    );
    expect(kept.values).toEqual({ interval: "45", quality: "low" });
    expect(kept.refused.map((problem) => problem.path)).toEqual(["/quality"]);
    // What the person is told names the field by its title, what is wrong, and what was typed.
    expect(notKeptSentence(SETTINGS, kept.refused)).toBe(
      'Not saved: Quality: must be one of "low", "high", not "medium". ' +
        "The value each had before is kept.",
    );
  });

  it("a write of only invalid fields touches nothing", () => {
    const previous = { quality: "low" };
    const kept = save(SETTINGS, previous, { quality: "medium" });
    expect(kept.values).toEqual(previous);
    // A field never set before stays unset: nothing is invented for it.
    expect(save(SETTINGS, {}, { quality: "medium" }).values).toEqual({});
  });

  it("a value for a property the schema does not declare is refused, and never taken", () => {
    const before = { interval: 20 };
    const kept = save(SETTINGS, before, { interval: "30", unknown: "refused" });
    expect(kept.values).toEqual({ interval: "30" });
    expect(kept.refused).toEqual([
      { path: "/unknown", message: "is not a declared property", value: "refused" },
    ]);
    expect(save(SETTINGS, { ...before, unknown: "kept" }, { unknown: "typed" }).values).toEqual({
      ...before,
      unknown: "kept",
    });
  });

  it("a field the save does not carry keeps its value", () => {
    expect(save(SETTINGS, { interval: 20, quality: "low" }, { interval: "25" }).values).toEqual({
      interval: "25",
      quality: "low",
    });
  });

  it("a group's fields are judged one by one, like the form's own", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        retry: { type: "object", properties: { attempts: INTERVAL, quality: QUALITY } },
      },
    };
    const kept = save(
      schema,
      { retry: { attempts: 2, quality: "low" } },
      { retry: { attempts: "3", quality: "medium" } },
    );
    expect(kept.values).toEqual({ retry: { attempts: "3", quality: "low" } });
  });
});

describe("a save of a table, row by row", () => {
  it("a write of three new rows records the two that pass", () => {
    const schema = volumes();
    const kept = save(
      schema,
      {},
      {
        volumes: [{ label: "Zoom H6" }, { label: "Field recorder" }, { volume_uuid: "8A1F-22C3" }],
      },
    );
    expect(rows(kept.values["volumes"]).map((row) => row["label"])).toEqual([
      "Zoom H6",
      "Field recorder",
    ]);
    expect(describedProblems(schema, kept.refused)).toBe("Volumes, row 3, Label: fill this in.");
  });

  it("an added row that fails is absent rather than partly recorded", () => {
    const kept = save(
      volumes(),
      {},
      { volumes: [{ label: "Zoom H6" }, { volume_uuid: "8A1F-22C3", destination: "/tmp/x" }] },
    );
    expect(JSON.stringify(kept.values)).not.toContain("8A1F-22C3");
    expect(JSON.stringify(kept.values)).not.toContain("/tmp/x");
    expect(rows(kept.values["volumes"])).toHaveLength(1);
  });

  it("an edited row that fails keeps the row at its place before, whole", () => {
    const before = {
      volumes: [{ label: "one" }, { label: "two", volume_uuid: "8A1F-22C3" }, { label: "three" }],
    };
    const kept = save(volumes(), before, {
      volumes: [{ label: "ONE" }, { volume_uuid: "9B2E-11D4" }, { label: "THREE" }],
    });
    expect(kept.refused[0]?.path).toBe("/volumes/1/label");
    const recorded = rows(kept.values["volumes"]);
    expect(recorded.map((row) => row["label"])).toEqual(["ONE", "two", "THREE"]);
    expect(recorded[1]?.["volume_uuid"]).toBe("8A1F-22C3");
  });

  it("a refused row's submitted values are said beside its error, and the row before is kept", () => {
    const gain = { type: "integer", title: "Gain", minimum: 1 };
    const schema = volumes({ gain });
    const before = {
      volumes: [
        { label: "one", gain: 5 },
        { label: "two", gain: 5 },
      ],
    };
    const submitted = {
      volumes: [
        { label: "one", gain: "5" },
        { label: "two-edited", gain: "0" },
      ],
    };
    const kept = save(schema, before, submitted);
    expect(rows(kept.values["volumes"]).map((row) => row["label"])).toEqual(["one", "two"]);
    // What was typed is said beside why, as the save ends and again as the form opens.
    expect(notKeptSentence(schema, kept.refused)).toBe(
      'Not saved: Volumes, row 2, Gain: must be 1 or more, not "0". ' +
        "The value each had before is kept.",
    );
  });

  it("a whole table refused (fewer rows than it must have) keeps the table before", () => {
    const schema = volumes();
    const table = schema["properties"] as Record<string, Record<string, unknown>>;
    const strict: JsonSchema = {
      type: "object",
      properties: { volumes: { ...table["volumes"], minItems: 1 } },
    };
    const before = { volumes: [{ label: "one" }] };
    expect(save(strict, before, { volumes: [] }).values).toEqual(before);
  });

  it("a column default fills a cell the row leaves out", () => {
    const globs = { type: "array", items: { type: "string" }, default: ["WAV/**/*.WAV"] };
    const schema = volumes({ globs });
    const kept = save(schema, {}, { volumes: [{ label: "Zoom H6" }] });
    // Kept as typed; the runtime's coercion gives the cell its default.
    expect(coerceObject(schema, kept.values)).toEqual({
      volumes: [{ label: "Zoom H6", globs: ["WAV/**/*.WAV"] }],
    });
  });
});

describe("a save of rows the person moved, removed or added", () => {
  const gain = { type: "integer", title: "Gain", minimum: 1 };
  const schema = volumes({ gain });
  const before = {
    volumes: [
      { label: "one", gain: 1 },
      { label: "two", gain: 2 },
      { label: "three", gain: 3 },
    ],
  };
  const labels = (kept: { values: Record<string, unknown> }) =>
    rows(kept.values["volumes"]).map((row) => [row["label"], row["gain"]]);

  it("a swapped row that fails keeps its own row before, at its new place", () => {
    // "two" moved up, then given a bad gain: it keeps "two" as it was, and "one" is not doubled.
    const submitted = {
      volumes: [
        { label: "two", gain: "0" },
        { label: "one", gain: "1" },
        { label: "three", gain: "3" },
      ],
    };
    const origins = new Map([["/volumes", [1, 0, 2]]]);
    expect(labels(save(schema, before, submitted, origins))).toEqual([
      ["two", 2],
      ["one", "1"],
      ["three", "3"],
    ]);
  });

  it("a row removed stays removed when another row fails", () => {
    const submitted = {
      volumes: [
        { label: "one", gain: "1" },
        { label: "three", gain: "0" },
      ],
    };
    const origins = new Map([["/volumes", [0, 2]]]);
    expect(labels(save(schema, before, submitted, origins))).toEqual([
      ["one", "1"],
      ["three", 3],
    ]);
  });

  it("a row added in front, failing, is left out, and the rows after it keep their own", () => {
    const submitted = {
      volumes: [
        { label: "new", gain: "0" },
        { label: "one", gain: "1" },
        { label: "two", gain: "-2" },
        { label: "three", gain: "3" },
      ],
    };
    const origins = new Map([["/volumes", [null, 0, 1, 2]]]);
    expect(labels(save(schema, before, submitted, origins))).toEqual([
      ["one", "1"],
      ["two", 2],
      ["three", "3"],
    ]);
  });

  it("a table whose rows cannot be matched is kept whole when any row fails", () => {
    const submitted = {
      volumes: [
        { label: "two", gain: "0" },
        { label: "one", gain: "1" },
      ],
    };
    const kept = save(schema, before, submitted, new Map());
    expect(kept.values).toEqual(before);
    expect(kept.refused.map((problem) => problem.path)).toEqual(["/volumes/0/gain"]);
    // With no failure, it is taken as it came.
    const clean = { volumes: [{ label: "two", gain: "2" }] };
    expect(save(schema, before, clean, new Map()).values).toEqual(clean);
  });
});

describe("values nobody declares, at every depth", () => {
  it("a cell no column draws survives a save of its row, and of its row moved", () => {
    const schema = volumes();
    const before = {
      volumes: [
        { label: "one", old_cell: "kept" },
        { label: "two", old_cell: "also kept" },
      ],
    };
    const edited = save(schema, before, { volumes: [{ label: "ONE" }, { label: "two" }] });
    expect(edited.values).toEqual({
      volumes: [
        { label: "ONE", old_cell: "kept" },
        { label: "two", old_cell: "also kept" },
      ],
    });
    const moved = save(
      schema,
      before,
      { volumes: [{ label: "two" }, { label: "one" }] },
      new Map([["/volumes", [1, 0]]]),
    );
    expect(rows(moved.values["volumes"]).map((row) => row["old_cell"])).toEqual([
      "also kept",
      "kept",
    ]);
  });

  it("a value inside a group survives a clean save of the group", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { retry: { type: "object", properties: { attempts: INTERVAL } } },
    };
    const before = { retry: { attempts: 2, jitter: 0.5 } };
    expect(save(schema, before, { retry: { attempts: "3" } }).values).toEqual({
      retry: { attempts: "3", jitter: 0.5 },
    });
  });
});

describe("a save of a nested table", () => {
  const schema = volumes({ takes: TAKES });

  it("a nested row added to a row that had none has nothing to fall back on", () => {
    const kept = save(
      schema,
      { volumes: [{ label: "Zoom H6" }] },
      { volumes: [{ label: "Zoom H6", takes: [{ file: 5 }] }] },
    );
    expect(describedProblems(schema, kept.refused)).toBe(
      "Volumes, row 1, Takes, row 1, file: must be text.",
    );
    // The recorder is still recorded; the take being added simply is not there.
    expect(rows(kept.values["volumes"])[0]).toEqual({ label: "Zoom H6", takes: [] });
  });

  it("a nested table cell that is not a list refuses its row", () => {
    const kept = save(
      schema,
      {},
      { volumes: [{ label: "Zoom H6", takes: "one" }, { label: "Field recorder" }] },
    );
    expect(describedProblems(schema, kept.refused)).toBe("Volumes, row 1, Takes: must be a list.");
    expect(rows(kept.values["volumes"]).map((row) => row["label"])).toEqual(["Field recorder"]);
  });

  it("a refused nested row keeps the nested row previously there", () => {
    const before = {
      volumes: [{ label: "Zoom H6", takes: [{ file: "/tmp/one.wav" }, { file: "/tmp/two.wav" }] }],
    };
    const kept = save(schema, before, {
      volumes: [{ label: "Zoom H6", takes: [{ file: "/tmp/ONE.wav" }, { file: 5 }] }],
    });
    expect(kept.refused.map((problem) => problem.path)).toEqual(["/volumes/0/takes/1/file"]);
    const takes = rows(rows(kept.values["volumes"])[0]?.["takes"]);
    expect(takes.map((take) => take["file"])).toEqual(["/tmp/ONE.wav", "/tmp/two.wav"]);
  });

  it("a refused row deep in a nested table refuses only itself", () => {
    const kept = save(
      schema,
      {},
      {
        volumes: [
          {
            label: "Zoom H6",
            takes: [
              { file: "/tmp/one.wav" },
              { file: "/tmp/two.wav", markers: [{ at: -1 }, { at: 9 }] },
            ],
          },
        ],
      },
    );
    expect(describedProblems(schema, kept.refused)).toMatch(
      /^Volumes, row 1, Takes, row 2, Markers, row 1, at: must be 0 or more\.$/,
    );
    const takes = rows(rows(kept.values["volumes"])[0]?.["takes"]);
    expect(takes.map((take) => take["file"])).toEqual(["/tmp/one.wav", "/tmp/two.wav"]);
    expect(rows(takes[1]?.["markers"]).map((marker) => marker["at"])).toEqual([9]);
  });

  it("a row whose own cell and nested row both fail is refused whole", () => {
    const before = { volumes: [{ label: "kept", takes: [] }] };
    const kept = save(schema, before, { volumes: [{ label: "", takes: [{ file: 5 }] }] });
    expect(kept.values).toEqual(before);
    expect(kept.refused).toHaveLength(2);
  });
});

describe("a save the whole form refuses", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      host: { type: "string", title: "Host" },
      port: { type: "integer", title: "Port" },
      label: { type: "string", title: "Label" },
    },
    dependentRequired: { host: ["port"] },
  };

  it("keeps every good stored value, and says which field to fill in", () => {
    const before = { host: "a.example", port: 80, label: "old" };
    const kept = save(schema, before, { host: "b.example", label: "new" });
    expect(kept.values).toEqual(before);
    expect(notKeptSentence(schema, kept.refused)).toBe(
      "Not saved: Port: fill this in, as Host is set. The value each had before is kept.",
    );
    // Any other refusal of the whole object is said of the form.
    const strict: JsonSchema = { ...schema, dependentRequired: undefined, minProperties: 3 };
    const few = save(strict, before, { label: "new" });
    expect(few.values).toEqual(before);
    expect(describedProblems(strict, few.refused)).toBe(
      "The form: must NOT have fewer than 3 properties.",
    );
  });
});

describe("what a save never takes, and what it leaves out", () => {
  it("a read-only value is shown, never typed over", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { recorded: { type: "string", readOnly: true }, label: { type: "string" } },
    };
    const kept = save(schema, { recorded: "by the plugin" }, { recorded: "typed", label: "x" });
    expect(kept.values).toEqual({ recorded: "by the plugin", label: "x" });
  });

  it("a value the schema now forbids where it was is left out, and said, so the node is repairable", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        retry: {
          type: "object",
          additionalProperties: false,
          properties: { attempts: INTERVAL },
        },
      },
    };
    const before = { retry: { attempts: 2, jitter: 0.5 } };
    const kept = save(schema, before, { retry: { attempts: "3" } });
    expect(kept.values).toEqual({ retry: { attempts: "3" } });
    expect(kept.dropped).toEqual(["/retry/jitter"]);
    expect(droppedSentence(kept.dropped)).toBe("Left out, as the step no longer takes it: jitter.");
    expect(droppedSentence(["/a", "/b_c"])).toBe(
      "Left out, as the step no longer takes them: a, b c.",
    );
  });
});

describe("a bad cell in a table inside a group inside a row", () => {
  it("refuses only that nested row; the parent row's other edits survive", () => {
    const schema = volumes({
      settings: {
        type: "object",
        title: "Settings",
        properties: { takes: TAKES },
      },
    });
    const before = { volumes: [{ label: "one", settings: { takes: [{ file: "/a.wav" }] } }] };
    const kept = save(schema, before, {
      volumes: [{ label: "ONE", settings: { takes: [{ file: "/A.wav" }, { file: 5 }] } }],
    });
    expect(kept.values).toEqual({
      volumes: [{ label: "ONE", settings: { takes: [{ file: "/A.wav" }] } }],
    });
    expect(kept.refused.map((problem) => problem.path)).toEqual([
      "/volumes/0/settings/takes/1/file",
    ]);
  });
});

describe("a refused save kept until it is corrected", () => {
  const gain = { type: "integer", title: "Gain", minimum: 1 };
  const schema = volumes({ gain });
  const before = {
    volumes: [
      { label: "one", gain: 1 },
      { label: "two", gain: 2 },
    ],
  };
  const submitted = {
    volumes: [
      { label: "new", gain: "0" },
      { label: "two-edited", gain: "0" },
      { label: "one", gain: "1" },
    ],
  };

  it("keeps all that was typed, why, and where each typed row now stands", () => {
    const kept = save(schema, before, submitted, new Map([["/volumes", [null, 1, 0]]]));
    // Stored: "two" kept at its own place, "one" saved; the added row left out.
    expect(rows(kept.values["volumes"]).map((row) => row["label"])).toEqual(["two", "one"]);
    const stored = storedRefusal(schema, submitted, kept);
    expect(stored?.values).toEqual(submitted);
    // Every cell typed is kept, the good with the bad: "two-edited" with its refused gain.
    expect(rows(stored?.values["volumes"])[1]).toEqual({ label: "two-edited", gain: "0" });
    expect(stored?.origins).toEqual([["/volumes", [null, 0, 1]]]);
    expect(readRefusal(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("is matched against the stored rows on the next save, so nothing is lost", () => {
    const first = save(schema, before, submitted, new Map([["/volumes", [null, 1, 0]]]));
    const stored = storedRefusal(schema, submitted, first);
    if (stored === null) throw new Error("nothing was refused");
    // Corrected: the typed rows matched where their stored rows now stand.
    const corrected = {
      volumes: [
        { label: "new", gain: "3" },
        { label: "two-edited", gain: "2" },
        { label: "one", gain: "1" },
      ],
    };
    const second = save(schema, first.values, corrected, new Map(stored.origins));
    expect(rows(second.values["volumes"]).map((row) => row["label"])).toEqual([
      "new",
      "two-edited",
      "one",
    ]);
    expect(storedRefusal(schema, corrected, second)).toBeNull();
  });

  it("reads back nothing that is not of its shape", () => {
    for (const raw of [
      null,
      "x",
      { values: 1 },
      { values: {}, problems: "x", origins: [] },
      { values: {}, problems: [{ path: 1 }], origins: [] },
      { values: {}, problems: [], origins: "x" },
      { values: {}, problems: [], origins: [["/v", ["a"]]] },
    ]) {
      expect(readRefusal(raw)).toBeNull();
    }
  });
});

describe("a refused save never keeps a secret", () => {
  it("takes every secret out of what was typed and of each refusal, at any depth", () => {
    const full: JsonSchema = {
      type: "object",
      properties: {
        label: { type: "string", title: "Label", minLength: 2 },
        keyring: {
          type: "array",
          title: "Keyring",
          items: { type: "array", items: { type: "string", writeOnly: true } },
        },
        account: {
          type: "object",
          properties: { password: { type: "string", writeOnly: true }, user: { type: "string" } },
        },
      },
    };
    const submitted = {
      label: "x",
      keyring: [["hunter2"]],
      account: { password: "hunter3", user: "me" },
    };
    const kept = {
      values: {},
      refused: [
        { path: "/label", message: "must NOT have fewer than 2 characters", value: "x" },
        { path: "/keyring/0", message: "is wrong", value: ["hunter2"] },
        { path: "/account/password", message: "is wrong", value: "hunter3" },
      ],
      dropped: [],
      origins: new Map(),
    };
    const stored = storedRefusal(full, submitted, kept);
    expect(JSON.stringify(stored)).not.toMatch(/hunter/);
    expect(stored?.values).toEqual({ label: "x", account: { user: "me" } });
    expect(stored?.problems.map((problem) => problem.value)).toEqual(["x", undefined, undefined]);
    // So the sentence said beside the field and in the notice holds none either.
    expect(notKeptSentence(full, stored?.problems ?? [])).not.toMatch(/hunter/);
  });
});
