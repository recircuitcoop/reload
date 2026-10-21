// Where a failed step threw, as both SDKs add it to the `error` frame (plan 0029): the TS SDK's
// half (the Python SDK's is sdk/python/tests/test_node.py). The class's name, and the innermost
// stack frame inside the package's folder, relative to it; a library's frame gives way to the
// package's own; outside the folder, only the type.
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { thrownAt } from "../../../sdk/ts/src/node";

class CatalogueGone extends Error {}

const stackOf = (...frames: string[]): Error => {
  const error = new CatalogueGone("gone");
  error.stack = ["CatalogueGone: gone", ...frames].join("\n");
  return error;
};

describe("thrownAt", () => {
  it("names the class and the package's own innermost frame, relative to its folder", () => {
    const root = path.resolve("/pkg");
    const caught = stackOf(
      `    at Object.<anonymous> (${path.join(root, "node_modules", "lib", "index.js")}:3:9)`,
      "    at node:internal/modules/cjs/loader:1:1",
      `    at handle (${path.join(root, "dist", "main.cjs")}:120:15)`,
      `    at file://${path.join(root, "src", "outer.mjs")}:4:2`,
    );
    expect(thrownAt(caught, root)).toEqual({
      error_type: "CatalogueGone",
      file: "dist/main.cjs",
      line: 120,
    });
    expect(thrownAt(stackOf(`    at file://${path.join(root, "src", "a.mjs")}:9:1`), root)).toEqual(
      { error_type: "CatalogueGone", file: "src/a.mjs", line: 9 },
    );
  });

  it("is the type only when no frame is inside the folder, and nothing for what is not an Error", () => {
    const caught = stackOf("    at /elsewhere/x.js:1:1", "    at native", "    at (/pkg:1:1)");
    expect(thrownAt(caught, path.resolve("/pkg"))).toEqual({ error_type: "CatalogueGone" });
    const bare = new Error("no stack");
    bare.stack = undefined as unknown as string;
    expect(thrownAt(bare, "/pkg")).toEqual({ error_type: "Error" });
    expect(thrownAt("a string", "/pkg")).toEqual({});
  });

  it("finds this very line in a real stack, from the working directory", () => {
    let caught: unknown;
    try {
      throw new TypeError("real");
    } catch (error) {
      caught = error;
    }
    expect(thrownAt(caught)).toEqual({
      error_type: "TypeError",
      file: "test/unit/sdk-thrown-at.test.ts",
      line: 48,
    });
  });
});
