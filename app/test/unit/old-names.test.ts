// The old names' pure helpers (plan 0028 D3): the refusals' words, the search for the old
// keyword, and the one-time renaming of what 0.3.0 stored. The conformance stage drives the
// refusals through a real package folder; this pins each helper's edges on its own.

import { describe, expect, it } from "vitest";

import {
  oldDeclarationProblem,
  oldKeywordAt,
  oldKeywordProblem,
  renamedMessage,
  renamedNodeType,
} from "../../src/domain/packages/old-names";

describe("the refusals of the old names", () => {
  it("name the old file or keyword and the new one to rename it to", () => {
    expect(oldDeclarationProblem("reload-package.json")).toBe(
      "it has inny-package.json, the file InnyTypes read: Reload reads reload-package.json, " +
        "so rename the file to reload-package.json",
    );
    expect(oldKeywordProblem("/properties/a", "reload")).toBe(
      "/properties/a: the keyword innytype is what InnyTypes read; Reload reads reload, " +
        "so rename it to reload",
    );
  });
});

describe("oldKeywordAt", () => {
  it("finds the first old keyword at any depth, escaping the pointer", () => {
    expect(oldKeywordAt({ properties: { "a/b~c": { innytype: {} } } })).toBe(
      "/properties/a~1b~0c/innytype",
    );
    expect(oldKeywordAt({ items: [{ innytype: 1 }] })).toBe("/items/0/innytype");
  });

  it("finds none in a scalar, in a clean schema, or as an array's value", () => {
    expect(oldKeywordAt("innytype")).toBeNull();
    expect(oldKeywordAt(null)).toBeNull();
    expect(oldKeywordAt({ properties: { a: { reload: {} } } })).toBeNull();
    // An array's elements are not keys, so the word as a value is not the keyword.
    expect(oldKeywordAt({ enum: ["innytype"] })).toBeNull();
  });
});

describe("what 0.3.0 stored, renamed", () => {
  it("renames an old node type, keeping a package that was not renamed", () => {
    expect(renamedNodeType("inny-monty-mount")).toBe("reload-reload_mount-mount");
    expect(renamedNodeType("inny-other_pkg-x")).toBe("reload-other_pkg-x");
    expect(renamedNodeType("function")).toBe("function");
  });

  it("moves the envelope under reload with its sources renamed, never the payload", () => {
    const message = {
      payload: { source: "inny://monty/x/1" },
      inny: {
        source: "inny://monty/mount/1",
        trail: ["inny://unknown/t/2", 3],
        nested: { from: "inny://folder/f/9" },
        count: 1,
      },
    };
    expect(renamedMessage(message)).toEqual({
      payload: { source: "inny://monty/x/1" },
      reload: {
        source: "reload://reload_mount/mount/1",
        trail: ["reload://unknown/t/2", 3],
        nested: { from: "reload://reload_folder/f/9" },
        count: 1,
      },
    });
  });

  it("returns a message with no old envelope as it is", () => {
    const message = { payload: 1, reload: { source: "reload://a/b/c" } };
    expect(renamedMessage(message)).toBe(message);
    expect(renamedMessage("text")).toBe("text");
    expect(renamedMessage(null)).toBeNull();
  });
});
