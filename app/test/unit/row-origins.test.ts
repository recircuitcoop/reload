// domain/forms/row-origins.ts: which stored row each row of the canvas form was drawn from, so a
// save matches rows by it, never by their place (plan 0032 group 28).

import { describe, expect, it } from "vitest";

import { formModel } from "../../src/domain/forms/form-model";
import { originsOf, seedOrigins } from "../../src/domain/forms/row-origins";

const { fields } = formModel({
  type: "object",
  properties: {
    name: { type: "string" },
    group: {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
      },
    },
    volumes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          takes: {
            type: "array",
            items: { type: "object", properties: { file: { type: "string" } } },
          },
        },
      },
    },
  },
});

describe("row origins", () => {
  it("seeds every stored row, at every depth, with its own index", () => {
    const stored = {
      name: "n",
      group: { rows: [{ a: "x" }] },
      volumes: [{ label: "one", takes: [{ file: "f1" }, { file: "f2" }] }, { label: "two" }],
    };
    const origins = new WeakMap<object, number>();
    seedOrigins(fields, stored, origins);
    expect(originsOf(fields, stored, origins)).toEqual(
      new Map([
        ["/group/rows", [0]],
        ["/volumes", [0, 1]],
        ["/volumes/0/takes", [0, 1]],
      ]),
    );
  });

  it("follows a row that moved, and knows a row added since as new", () => {
    const origins = new WeakMap<object, number>();
    const two = { label: "two" };
    const one = { label: "one" };
    origins.set(two, 1);
    origins.set(one, 0);
    const read = { volumes: [two, { label: "added" }, one, "not a row"] };
    expect(originsOf(fields, read, origins).get("/volumes")).toEqual([1, null, 0, null]);
    // A stored entry that is not a row, or a table or group of the wrong shape, is passed over.
    const odd = { group: { rows: "none" }, volumes: ["not a row", { label: "row", takes: 5 }] };
    seedOrigins(fields, odd, origins);
    expect(originsOf(fields, odd, origins)).toEqual(new Map([["/volumes", [null, 1]]]));
    // A table, or a group, holding no rows has nothing to match.
    seedOrigins(fields, { volumes: "not rows", group: "not a group" }, origins);
    expect(originsOf(fields, { volumes: "not rows" }, origins)).toEqual(new Map());
  });
});
