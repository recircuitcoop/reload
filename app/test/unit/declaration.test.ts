// domain/packages/declaration.ts with the real ajv validator (adapters/schema): node package
// declarations parsed against the spec's §2.6 schema, and refused by field (spec 2, 1.3, 5.2).
// Several behaviours of the old manifest parser (tests/test_addon_manifest.py) carry over: a
// parsed declaration is frozen, every refusal names its field, and a version this runtime does
// not implement is refused naming both versions.

import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import {
  inputsOf,
  nodeTypeName,
  parseDeclaration,
  portsOf,
  stabilityOf,
  type DeclaredType,
  type ParsedDeclaration,
} from "../../src/domain/packages/declaration";
import { DEFAULT_LIMITS, typeLimits } from "../../src/domain/supervision/resources";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const validator = new AjvSchemaValidator();
const parse = (value: unknown): ParsedDeclaration => parseDeclaration(value, validator);

/** The problems of a refused declaration; fails the test when it was accepted. */
function refused(value: unknown): readonly string[] {
  const parsed = parse(value);
  if (parsed.ok) {
    throw new Error("the declaration was accepted");
  }
  return parsed.problems;
}

function nodeType(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "diarize",
    kind: "node",
    label: "Diarize",
    command: ["{python}", "{package}/diarize.py"],
    config: { type: "object" },
    outputs: [{ port: "done", event: "monty.diarized.v1" }],
    ...overrides,
  };
}

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: 2, package: "monty", version: "0.1.0", types: [nodeType()], ...overrides };
}

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

/** The spec's own §2.7 example. */
function specExample(): unknown {
  const spec = fs.readFileSync(path.join(REPOSITORY, "docs/specs/node-protocol-v2.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 2.7 Example"), spec.indexOf("## 3. Transport"));
  return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "");
}

describe("the declaration schema file", () => {
  it("is exactly the JSON Schema block of spec §2.6", () => {
    const spec = fs.readFileSync(path.join(REPOSITORY, "docs/specs/node-protocol-v2.md"), "utf8");
    const section = spec.slice(
      spec.indexOf("### 2.6 JSON Schema"),
      spec.indexOf("### 2.7 Example"),
    );
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";
    const file = fs.readFileSync(
      path.join(REPOSITORY, "docs/specs/reload-package.v2.schema.json"),
      "utf8",
    );
    expect(JSON.parse(file)).toEqual(JSON.parse(block));
  });
});

describe("parseDeclaration", () => {
  it("parses the spec's own example into readable fields", () => {
    const parsed = parse(specExample());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { declaration: d } = parsed;
    expect(d.package).toBe("monty");
    expect(d.version).toBe("0.1.0");
    expect(d.environment).toEqual({ kind: "uv-python", python: "3.13" });
    const [watcher] = d.types;
    expect(watcher?.kind).toBe("source");
    expect(watcher?.label).toBe("Folder watcher");
    expect(watcher?.outputs.map((o) => o.port)).toEqual(["new", "updated", "deleted"]);
    expect(watcher?.config["required"]).toEqual(["folder"]);
  });

  it("parses a declaration without the optional sections", () => {
    const parsed = parse(declaration());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.declaration.environment).toBeUndefined();
  });

  it("accepts the protocol this runtime implements", () => {
    expect(parse(declaration({ protocol: 2 })).ok).toBe(true);
  });

  it("refuses a protocol this runtime does not implement, naming both versions", () => {
    expect(refused(declaration({ protocol: 3 }))).toEqual([
      "protocol: 3 is not implemented by this runtime, which implements protocol 2",
    ]);
    expect(refused(declaration({ protocol: 1 }))[0]).toContain("protocol: 1 is not implemented");
  });

  it("accepts an answer schema on a view type only (spec 2.4)", () => {
    const answer = { type: "object", properties: { order: { type: "array" } } };
    const view = nodeType({ kind: "view", view: "action", answer });
    const parsed = parse(declaration({ types: [view] }));
    expect(parsed.ok && parsed.declaration.types[0]?.answer).toEqual(answer);
    expect(refused(declaration({ types: [nodeType({ answer })] }))).toEqual([
      "types/0/kind: must be equal to constant",
    ]);
  });

  it("accepts a props schema on an action view type only (spec 2.4)", () => {
    const props = { type: "object", properties: { items: { type: "array" } } };
    const view = nodeType({ kind: "view", view: "action", props });
    const parsed = parse(declaration({ types: [view] }));
    expect(parsed.ok && parsed.declaration.types[0]?.props).toEqual(props);
    expect(refused(declaration({ types: [nodeType({ props })] }))).toEqual([
      "types/0/kind: must be equal to constant",
    ]);
    const snapshot = nodeType({ kind: "view", view: "snapshot", props });
    expect(refused(declaration({ types: [snapshot] }))).toEqual([
      "types/0/view: must be equal to constant",
    ]);
  });

  it("lets every supervision field be set at once, and each is what supervises the type (spec 2.4.2)", () => {
    const reload = {
      heartbeat: { interval_s: 5, stale_after_s: 60 },
      limits: {
        memory_mb: 256,
        cpu_percent: 50,
        cpu_window_s: 30,
        open_files: 64,
        children: 2,
        grace_s: 10,
      },
      restartable: false,
    };
    const parsed = parse(declaration({ types: [nodeType({ reload })] }));
    const type = parsed.ok ? parsed.declaration.types[0] : undefined;
    expect(type?.reload).toEqual(reload);
    expect(type && stabilityOf(type)).toEqual({ heartbeatIntervalMs: 5_000, staleAfterMs: 60_000 });
    expect(typeLimits(type?.reload, DEFAULT_LIMITS)).toEqual({
      memoryMb: 256,
      cpuPercent: 50,
      cpuWindowMs: 30_000,
      openFiles: 64,
      children: 2,
      graceMs: 10_000,
    });
    expect(type?.reload?.restartable).toBe(false);
  });

  it("accepts resource limits on a type, and refuses an unknown key or a bad value (spec 2.4.2)", () => {
    const limits = {
      memory_mb: 1536.5,
      cpu_percent: 150,
      open_files: 4096,
      children: 64,
      grace_s: 120,
    };
    const parsed = parse(declaration({ types: [nodeType({ reload: { limits } })] }));
    expect(parsed.ok && parsed.declaration.types[0]?.reload?.limits).toEqual(limits);
    expect(parse(declaration({ types: [nodeType({ reload: {} })] })).ok).toBe(true);
    expect(refused(declaration({ types: [nodeType({ reload: { limit: {} } })] }))).toEqual([
      "types/0/reload/limit: is not a declared property",
    ]);
    expect(
      refused(declaration({ types: [nodeType({ reload: { limits: { memory: 4096 } } })] })),
    ).toEqual(["types/0/reload/limits/memory: is not a declared property"]);
    expect(
      refused(declaration({ types: [nodeType({ reload: { limits: { children: 0 } } })] })),
    ).toEqual(["types/0/reload/limits/children: must be >= 1"]);
    expect(
      refused(declaration({ types: [nodeType({ reload: { limits: { grace_s: 0 } } })] })),
    ).toEqual(["types/0/reload/limits/grace_s: must be > 0"]);
    expect(
      refused(declaration({ types: [nodeType({ reload: { limits: { open_files: 1.5 } } })] })),
    ).toEqual(["types/0/reload/limits/open_files: must be integer"]);
  });

  /** The refusals of one type's `reload`, as the old manifest refused its `stability`. */
  const reloadRefused = (reload: unknown): readonly string[] =>
    refused(declaration({ types: [nodeType({ reload })] }));

  it.each([0, -1])("refuses a memory limit of %d, naming it", (value) => {
    expect(reloadRefused({ limits: { memory_mb: value } })).toEqual([
      "types/0/reload/limits/memory_mb: must be > 0",
    ]);
  });

  it.each(["10", null, true])("refuses a limit that is not a number (%s), naming it", (value) => {
    expect(reloadRefused({ limits: { memory_mb: value } })).toEqual([
      "types/0/reload/limits/memory_mb: must be number",
    ]);
  });

  it("refuses a reload or a limits that is not an object, naming it", () => {
    expect(reloadRefused(["limits", 10])).toEqual(["types/0/reload: must be object"]);
    expect(reloadRefused({ limits: ["memory_mb", 10] })).toEqual([
      "types/0/reload/limits: must be object",
    ]);
  });

  it("accepts a type that says never to restart it, and refuses one that is not a yes or no (spec 2.4.2)", () => {
    const parsed = parse(declaration({ types: [nodeType({ reload: { restartable: false } })] }));
    expect(parsed.ok && parsed.declaration.types[0]?.reload).toEqual({ restartable: false });
    expect(refused(declaration({ types: [nodeType({ reload: { restartable: "no" } })] }))).toEqual([
      "types/0/reload/restartable: must be boolean",
    ]);
  });

  it("accepts a type's heartbeat, judged in ms, and refuses one outside a second to a day (spec 2.4.2)", () => {
    const beat = (heartbeat: unknown) =>
      declaration({ types: [nodeType({ reload: { heartbeat } })] });
    const parsed = parse(beat({ interval_s: 30, stale_after_s: 120 }));
    const type = parsed.ok ? parsed.declaration.types[0] : undefined;
    expect(type && stabilityOf(type)).toEqual({
      heartbeatIntervalMs: 30_000,
      staleAfterMs: 120_000,
    });
    const plain = parse(beat({ interval_s: 1.5 }));
    const half = plain.ok ? plain.declaration.types[0] : undefined;
    expect(half && stabilityOf(half)).toEqual({ heartbeatIntervalMs: 1_500, staleAfterMs: null });
    expect(stabilityOf(nodeType() as unknown as DeclaredType)).toBeNull();
    // From a second to a day: shorter cannot be answered, longer outlasts a timer and a person.
    expect(refused(beat({ interval_s: 0.5 }))).toEqual([
      "types/0/reload/heartbeat/interval_s: must be >= 1",
    ]);
    expect(refused(beat({ interval_s: 86_401 }))).toEqual([
      "types/0/reload/heartbeat/interval_s: must be <= 86400",
    ]);
    expect(refused(beat({ interval_s: 30, stale_after_s: 86_401 }))).toEqual([
      "types/0/reload/heartbeat/stale_after_s: must be <= 86400",
    ]);
    expect(parse(beat({ interval_s: 30, stale_after_s: 30 })).ok).toBe(true);
    expect(refused(beat({ interval_s: 60, stale_after_s: 30 }))).toEqual([
      "types/0/reload/heartbeat/stale_after_s: 30 s is shorter than interval_s (60 s); a " +
        "process must have at least one interval to answer before it is judged stuck",
    ]);
    expect(refused(beat({ stale_after_s: 90 }))).toEqual([
      "types/0/reload/heartbeat/interval_s: is required",
    ]);
  });

  it("refuses a key a type's reload object or its heartbeat does not define, naming it (spec 2.4.2)", () => {
    const typed = (reload: unknown) => declaration({ types: [nodeType({ reload })] });
    expect(refused(typed({ restartible: false }))).toEqual([
      "types/0/reload/restartible: is not a declared property",
    ]);
    expect(refused(typed({ heartbeat: { interval_s: 30, stale_s: 90 } }))).toEqual([
      "types/0/reload/heartbeat/stale_s: is not a declared property",
    ]);
    // `limits` is the resource limits' place: an object is allowed.
    expect(parse(typed({ restartable: true, limits: {} })).ok).toBe(true);
    expect(refused(typed({ limits: 5 }))).toEqual(["types/0/reload/limits: must be object"]);
  });

  it("a type's reload object must be an object, and an empty one promises no heartbeat (spec 2.4.2)", () => {
    const typed = (reload: unknown) => declaration({ types: [nodeType({ reload })] });
    expect(refused(typed(["heartbeat", 10]))).toEqual(["types/0/reload: must be object"]);
    expect(refused(typed({ heartbeat: [10] }))).toEqual([
      "types/0/reload/heartbeat: must be object",
    ]);
    const empty = parse(typed({}));
    const type = empty.ok ? empty.declaration.types[0] : undefined;
    expect(type && stabilityOf(type)).toBeNull();
    // Restarted as usual: a type says restartable false to be left stopped, never by omission.
    expect(type?.reload?.restartable).toBeUndefined();
  });

  it("refuses a heartbeat interval that is not a number, naming the field (spec 2.4.2)", () => {
    for (const interval_s of ["10", null, true]) {
      expect(
        refused(declaration({ types: [nodeType({ reload: { heartbeat: { interval_s } } })] })),
      ).toEqual(["types/0/reload/heartbeat/interval_s: must be number"]);
    }
  });

  it("refuses a protocol that is not the integer 2", () => {
    expect(refused(declaration({ protocol: "2" }))).toEqual([
      'protocol: "2" is not implemented by this runtime, which implements protocol 2',
    ]);
  });

  it.each(["protocol", "package", "version", "types"])(
    "refuses a declaration missing %s, by name",
    (field) => {
      expect(refused(without(declaration(), field))).toContain(`${field}: is required`);
    },
  );

  it.each(["id", "kind", "label", "command", "config", "outputs"])(
    "refuses a type missing %s, by its path",
    (field) => {
      const type = without(nodeType(), field);
      expect(refused(declaration({ types: [type] }))).toContain(`types/0/${field}: is required`);
    },
  );

  it("refuses a declaration that is not a JSON object", () => {
    for (const value of [[], "monty", 2, null]) {
      expect(refused(value)).toEqual(["the declaration: must be a JSON object"]);
    }
  });

  it("refuses a version that is not a string", () => {
    expect(refused(declaration({ version: 1 }))).toEqual(["version: must be string"]);
  });

  it.each(["1monty", "Whodunnit", "", "who dunnit", "m"])(
    "refuses a package name that cannot own event types: %j",
    (name) => {
      expect(refused(declaration({ package: name }))[0]).toMatch(/^package: must match pattern/);
    },
  );

  it.each([
    ".transcribed.v1",
    "Whodunnit.Transcribed.v1",
    "",
    "whodunnit..v1",
    "whodunnit.transcribed.1",
    "whodunnit.transcribed.v01",
    "whodunnit.transcribed.v0",
    "whodunnit.transcribed.vX",
    "whodunnit.transcribed",
  ])("refuses an event type name that breaks the grammar, by its path: %j", (event) => {
    const type = nodeType({ outputs: [{ port: "done", event }] });
    expect(refused(declaration({ types: [type] }))[0]).toMatch(
      /^types\/0\/outputs\/0\/event: must match pattern/,
    );
  });

  it("refuses emitting under another package's name, or under user (spec 5.2.3)", () => {
    const other = nodeType({ outputs: [{ port: "done", event: "whodunnit.transcribed.v1" }] });
    expect(refused(declaration({ types: [other] }))).toEqual([
      'types/0/outputs/0/event: "whodunnit.transcribed.v1" is owned by "whodunnit"; ' +
        "package monty may emit only monty.*",
    ]);
    const user = nodeType({ outputs: [{ port: "done", event: "user.note.v1" }] });
    expect(refused(declaration({ types: [user] }))[0]).toContain(
      "reserved for created event types",
    );
  });

  it("refuses a port named after a Node-RED message field, and a port declared twice", () => {
    const shadow = nodeType({ outputs: [{ port: "topic", event: "monty.a.v1" }] });
    expect(refused(declaration({ types: [shadow] }))).toEqual([
      'types/0/outputs/0/port: "topic" is a Node-RED message field',
    ]);
    const twice = nodeType({
      kind: "view",
      view: "snapshot",
      outputs: [{ port: "go", event: "monty.a.v1" }],
      actions: [{ id: "go", label: "Go", event: "monty.b.v1" }],
    });
    expect(refused(declaration({ types: [twice] }))).toEqual([
      'types/0/actions/0/id: port "go" is declared twice',
    ]);
  });

  it("refuses two types with one id in a package", () => {
    expect(refused(declaration({ types: [nodeType(), nodeType()] }))).toEqual([
      'types/1/id: "diarize" is declared twice in this package',
    ]);
  });

  it("refuses a view without its view kind, and actions on anything but a snapshot view", () => {
    expect(refused(declaration({ types: [nodeType({ kind: "view" })] }))).toContain(
      "types/0/view: is required",
    );
    const actions = [{ id: "again", label: "Again", event: "monty.again.v1" }];
    expect(refused(declaration({ types: [nodeType({ actions })] }))).toContain(
      "types/0/kind: must be equal to constant",
    );
  });

  it("lists every problem, not only the first", () => {
    const problems = refused(declaration({ version: 3, types: [nodeType({ label: "" })] }));
    expect(problems).toEqual(
      expect.arrayContaining([
        "version: must be string",
        "types/0/label: must NOT have fewer than 1 characters",
      ]),
    );
  });

  it("freezes a parsed declaration all the way down", () => {
    const parsed = parse(declaration());
    if (!parsed.ok) {
      throw new Error("refused");
    }
    const type = parsed.declaration.types[0] as DeclaredType;
    expect(Object.isFrozen(parsed.declaration)).toBe(true);
    expect(Object.isFrozen(type.outputs[0])).toBe(true);
    expect(() => {
      (type as { label: string }).label = "changed";
    }).toThrow(TypeError);
  });

  it("leaves the value it was given unfrozen and unchanged", () => {
    const value = declaration();
    parse(value);
    expect(Object.isFrozen(value)).toBe(false);
    expect(value).toEqual(declaration());
  });
});

describe("the ports and names of a type", () => {
  it("derives the Node-RED type name from the package and the type id (spec 2.1.4)", () => {
    expect(nodeTypeName("monty", "folder-watcher")).toBe("reload-monty-folder-watcher");
  });

  it("numbers the pass-through outputs first, then one port per action (spec 2.2)", () => {
    const type = nodeType({
      kind: "view",
      view: "snapshot",
      outputs: [
        { port: "shown", event: "monty.shown.v1" },
        { port: "kept", event: "monty.kept.v1" },
      ],
      actions: [{ id: "redo", label: "Redo", event: "monty.redo.v1" }],
    }) as unknown as DeclaredType;
    expect(portsOf(type)).toEqual([
      { port: "shown", event: "monty.shown.v1", label: "shown (monty.shown.v1)", action: false },
      { port: "kept", event: "monty.kept.v1", label: "kept (monty.kept.v1)", action: false },
      { port: "redo", event: "monty.redo.v1", label: "action: Redo", action: true },
    ]);
  });

  it("gives a source no input unless it declares one, and every other kind one", () => {
    const of = (fields: Record<string, unknown>) => inputsOf(nodeType(fields) as never);
    expect(of({ kind: "source" })).toBe(0);
    expect(of({ kind: "source", input: true })).toBe(1);
    expect(of({ kind: "node" })).toBe(1);
    expect(of({ kind: "view", view: "action" })).toBe(1);
  });
});
