// A package that requires another (domain/packages/requires.ts, spec 2.1.5; the old resolver,
// test_enable_switch.py, test_addons_remove.py): what is held back and why, in one shape, and
// who keeps a package from going.
import { describe, expect, it } from "vitest";

import { heldBack, requiredBy, requiresOf } from "../../src/domain/packages/requires";

const NONE = { off: [], refused: [] };

describe("a package that requires another", () => {
  it("is held back for one missing and for one off in the same shape, a sentence with a different ending", () => {
    const delta = { package: "delta", requires: ["beta"] };
    const beta = { package: "beta", requires: [] };
    expect(heldBack([beta, delta], { off: ["beta"], refused: [] })).toEqual(
      new Map([["delta", "requires beta, which is off"]]),
    );
    expect(heldBack([delta], NONE)).toEqual(
      new Map([["delta", "requires beta, which is not installed"]]),
    );
    expect(heldBack([delta], { off: [], refused: ["beta"] })).toEqual(
      new Map([["delta", "requires beta, which cannot be loaded"]]),
    );
    // Nothing is wrong with beta: it is never held back for being required.
    expect(heldBack([beta, delta], NONE)).toEqual(new Map());
  });

  it("holds back what requires one held back, whatever the order, and never one that is off", () => {
    const packages = [
      { package: "needy", requires: ["lonely"] },
      { package: "lonely", requires: ["absent"] },
      { package: "sleeping", requires: ["absent"] },
    ];
    expect(heldBack(packages, { off: ["sleeping"], refused: [] })).toEqual(
      new Map([
        ["lonely", "requires absent, which is not installed"],
        ["needy", "requires lonely, which is held back"],
      ]),
    );
  });

  it("names every package that is on and requires it, and none that is off", () => {
    const packages = [
      { package: "monty", requires: [] },
      { package: "whodunnit", requires: ["monty"] },
      { package: "watson", requires: ["monty"] },
    ];
    expect(requiredBy("monty", packages, [])).toBe("whodunnit, watson require monty");
    expect(requiredBy("monty", packages, ["watson"])).toBe("whodunnit requires monty");
    expect(requiredBy("monty", packages, ["watson", "whodunnit"])).toBeNull();
    expect(requiredBy("whodunnit", packages, [])).toBeNull();
  });

  it("reads requires from a declaration without judging the rest of it", () => {
    expect(requiresOf({ requires: ["beta", 7, "gamma"] })).toEqual(["beta", "gamma"]);
    expect(requiresOf({ requires: "beta" })).toEqual([]);
    expect(requiresOf(null)).toEqual([]);
    expect(requiresOf("not a declaration")).toEqual([]);
  });
});
