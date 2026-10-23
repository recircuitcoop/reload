// A package's types swapped while the runtime runs (application/package-types.ts) judged with
// every package, as at the start: what it requires decides whether it loads, the held back
// notice follows in both directions, and the packages that require it are judged again with it
// (spec 2.1.6).
import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { PackageTypes } from "../../src/application/package-types";
import type { LoadedType } from "../../src/domain/packages/declaration";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

function declared(name: string, requires: string[] = []) {
  return {
    name,
    folder: `/packages/${name}`,
    document: {
      protocol: 2,
      package: name,
      version: "1.0.0",
      requires,
      types: [
        {
          id: "one",
          kind: "node",
          label: "one",
          command: ["{package}/run"],
          config: { type: "object" },
          outputs: [],
        },
      ],
    },
  };
}

function harness(options: { deployed?: unknown[] } = {}) {
  const state = {
    packages: [declared("beta"), declared("delta", ["beta"])],
    unregistered: [] as string[],
  };
  const notifier = new RecordingNotifier();
  const reloaded: string[] = [];
  const types = new Map<string, LoadedType>();
  const loader = new PackageTypes({
    packages: () => state.packages,
    unregistered: () => state.unregistered,
    validator: new AjvSchemaValidator(),
    types,
    python: new Map(),
    generate: (entries) => entries.map((entry) => `reload-${entry.declaration.package}-one`),
    engine: {
      deployedFlows: () => Promise.resolve(options.deployed ?? []),
      reloadModule: (name) => {
        reloaded.push(name);
        return Promise.resolve();
      },
    },
    logger: new RecordingLogger(),
    notifier,
  });
  return { state, notifier, reloaded, types, loader };
}

describe("a package's types swapped without a restart, and what it requires", () => {
  it("withdraws the held back notice of one that requires it once it loads, and swaps that one too", async () => {
    const h = harness();
    h.state.unregistered = ["beta"];
    expect(await h.loader.reload({ name: "beta" })).toEqual({ ok: true, value: { types: [] } });
    expect(h.notifier.notices).toEqual([
      { kind: "package-held-back", subject: "delta", detail: "requires beta, which is off" },
    ]);
    expect([...h.types.keys()]).toEqual([]);

    h.state.unregistered = [];
    expect(await h.loader.reload({ name: "beta" })).toEqual({
      ok: true,
      value: { types: ["reload-beta-one", "reload-delta-one"] },
    });
    expect(h.notifier.cleared).toContain("package-held-back delta");
    expect([...h.types.keys()].sort()).toEqual(["reload-beta-one", "reload-delta-one"]);
    expect(h.reloaded).toEqual(["beta", "delta", "beta", "delta"]);
  });

  it("holds back an update that now requires a package not installed, and says so", async () => {
    const h = harness();
    await h.loader.reload({ name: "delta" });
    expect(h.types.has("reload-delta-one")).toBe(true);

    h.state.packages = [declared("beta"), declared("delta", ["absent"])];
    expect(await h.loader.reload({ name: "delta" })).toEqual({ ok: true, value: { types: [] } });
    expect(h.types.has("reload-delta-one")).toBe(false);
    expect(h.notifier.notices).toEqual([
      {
        kind: "package-held-back",
        subject: "delta",
        detail: "requires absent, which is not installed",
      },
    ]);
  });

  it("is refused while a deployed node uses a package that requires it", async () => {
    const h = harness({ deployed: [{ id: "n1", type: "reload-delta-one", z: "tab1" }] });
    await h.loader.reload({ name: "delta" });
    h.reloaded.length = 0;
    expect(await h.loader.reload({ name: "beta" })).toEqual({
      ok: false,
      error:
        "beta, delta are used by deployed node n1, so beta's types are not swapped while the " +
        "runtime runs",
    });
    expect(h.reloaded).toEqual([]);
  });
});
