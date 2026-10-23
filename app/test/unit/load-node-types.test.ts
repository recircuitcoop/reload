// application/load-node-types.ts: every declaration the store read is judged, a refused package
// is left out whole with its reasons, and the others still load (spec 1.3, 2.6).

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { loadNodeTypes, unregisteredNames } from "../../src/application/load-node-types";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const validator = new AjvSchemaValidator();

function declared(name: string, overrides: Record<string, unknown> = {}) {
  const type = (id: string) => ({
    id,
    kind: "node",
    label: id,
    command: ["{package}/run"],
    config: { type: "object" },
    outputs: [{ port: "out", event: `${name}.out.v1` }],
  });
  return {
    name,
    folder: `/packages/${name}`,
    document: {
      protocol: 2,
      package: name,
      version: "1.0.0",
      types: [type("one"), type("two")],
      ...overrides,
    },
  };
}

describe("loadNodeTypes", () => {
  it("loads every type of every accepted package, with its folder", () => {
    const logger = new RecordingLogger();
    const loaded = loadNodeTypes([declared("alpha"), declared("beta")], validator, logger);
    expect(loaded.map((l) => `${l.declaration.package}/${l.type.id} ${l.folder}`)).toEqual([
      "alpha/one /packages/alpha",
      "alpha/two /packages/alpha",
      "beta/one /packages/beta",
      "beta/two /packages/beta",
    ]);
    expect(logger.lines).toEqual([]);
  });

  it("leaves an unregistered package's types out, and says so (plan 0022 §F, D6)", () => {
    const logger = new RecordingLogger();
    const loaded = loadNodeTypes([declared("alpha"), declared("beta")], validator, logger, [
      "alpha",
    ]);
    expect(loaded.map((l) => l.declaration.package)).toEqual(["beta", "beta"]);
    expect(logger.lines).toEqual([
      "INFO node package alpha is unregistered: its types are not loaded",
    ]);
  });

  it("reads the unregistered names from the packages setting; an unreadable one unregisters none", () => {
    const logger = new RecordingLogger();
    expect(unregisteredNames(() => ({ unregistered: ["alpha"] }), logger)).toEqual(["alpha"]);
    expect(unregisteredNames(() => undefined, logger)).toEqual([]);
    expect(unregisteredNames(() => ({ unregistered: "alpha" }), logger)).toEqual([]);
    expect(logger.lines.some((line) => line.startsWith("WARN the packages setting"))).toBe(true);
  });

  it("refuses a package of another protocol, naming the version, and loads the rest", () => {
    const logger = new RecordingLogger();
    const loaded = loadNodeTypes(
      [declared("alpha", { protocol: 3 }), declared("beta")],
      validator,
      logger,
    );
    expect(loaded.map((l) => l.declaration.package)).toEqual(["beta", "beta"]);
    expect(logger.lines).toEqual([
      "ERROR node package alpha (/packages/alpha) is refused and not loaded: protocol: 3 is " +
        "not implemented by this runtime, which implements protocol 2",
    ]);
  });

  it("refuses a package the schema refuses, with every reason by field", () => {
    const logger = new RecordingLogger();
    expect(
      loadNodeTypes([declared("alpha", { version: 1, types: [] })], validator, logger),
    ).toEqual([]);
    expect(logger.lines).toEqual([
      "ERROR node package alpha (/packages/alpha) is refused and not loaded: version: must be " +
        "string; types: must NOT have fewer than 1 items",
    ]);
  });
});

// A package that requires another (spec 2.1.6; the old resolver's holds, test_host_children.py,
// test_addons_cli.py, test_enable_switch.py).
describe("a package that requires another", () => {
  const packagesOf = (loaded: ReturnType<typeof loadNodeTypes>) => [
    ...new Set(loaded.map((l) => l.declaration.package)),
  ];

  it("is held back while the one it requires is off, loads none of its types, and says why once", () => {
    const logger = new RecordingLogger();
    const notifier = new RecordingNotifier();
    const loaded = loadNodeTypes(
      [
        declared("alpha"),
        declared("beta"),
        declared("gamma"),
        declared("delta", { requires: ["beta"] }),
      ],
      validator,
      logger,
      ["beta"],
      notifier,
    );
    // Never spawned: none of delta's types is there to deploy. beta itself is not held back.
    expect(packagesOf(loaded)).toEqual(["alpha", "gamma"]);
    expect(logger.lines).toContain(
      "WARN held back node package delta: it requires beta, which is off; its types are not loaded",
    );
    expect(notifier.notices).toEqual([
      { kind: "package-held-back", subject: "delta", detail: "requires beta, which is off" },
    ]);
    expect(notifier.cleared).toEqual(["package-held-back alpha", "package-held-back gamma"]);
  });

  it("is held back for one not installed, and so is what requires it in turn, each said in the same shape", () => {
    const logger = new RecordingLogger();
    const notifier = new RecordingNotifier();
    const loaded = loadNodeTypes(
      [
        declared("lonely", { requires: ["absent"] }),
        declared("needy", { requires: ["lonely"] }),
        declared("alpha"),
      ],
      validator,
      logger,
      [],
      notifier,
    );
    expect(packagesOf(loaded)).toEqual(["alpha"]);
    expect(notifier.notices.map((notice) => [notice.subject, notice.detail])).toEqual([
      ["lonely", "requires absent, which is not installed"],
      ["needy", "requires lonely, which is held back"],
    ]);
  });

  it("loads once what it requires loads, and its notice is withdrawn", () => {
    const notifier = new RecordingNotifier();
    const loaded = loadNodeTypes(
      [declared("beta"), declared("delta", { requires: ["beta"] })],
      validator,
      new RecordingLogger(),
      [],
      notifier,
    );
    expect(packagesOf(loaded)).toEqual(["beta", "delta"]);
    expect(notifier.cleared).toContain("package-held-back delta");
  });

  it("is refused when it takes the name a terminal command gives Reload's own process", () => {
    const logger = new RecordingLogger();
    expect(loadNodeTypes([declared("services")], validator, logger)).toEqual([]);
    expect(logger.lines).toEqual([
      "ERROR node package services (/packages/services) is refused and not loaded: package: " +
        '"services" is reserved: `reload --kill services` names Reload\'s own process',
    ]);
  });

  it("is refused when it requires itself, or names a package that is no package name", () => {
    const logger = new RecordingLogger();
    expect(
      loadNodeTypes(
        [
          declared("alpha", { requires: ["alpha"] }),
          declared("beta", { requires: ["Not A Name"] }),
        ],
        validator,
        logger,
      ),
    ).toEqual([]);
    expect(logger.lines).toEqual([
      "ERROR node package alpha (/packages/alpha) is refused and not loaded: requires: a package " +
        "cannot require itself",
      expect.stringMatching(/^ERROR node package beta .*requires\/0: must match pattern/),
    ]);
  });
});
