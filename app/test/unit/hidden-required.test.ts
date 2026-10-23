// @vitest-environment happy-dom
//
// A property `reload.shown` hides is not judged while it is hidden (domain/forms/hidden.ts;
// plan 0032, group 2): a required token shown only when mode is "b" never holds a step whose
// mode is "a" back, in the canvas form, in whether the step is set up, and nowhere is its reason
// drawn; shown again, it is required again.

import { beforeAll, describe, expect, it } from "vitest";

import "../../src/adapters/nodered/editor-forms";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { isSetUp } from "../../src/application/flow-summary";
import type { TabNode } from "../../src/domain/flows/tab";
import { hiddenPaths, unhidden } from "../../src/domain/forms/hidden";
import type { FlowNodeType } from "../../src/ports/flow-admin";

const TYPE = "reload-demo-hidden";
const CONFIG = {
  type: "object",
  required: ["mode", "token", "host"],
  properties: {
    mode: { type: "string", title: "Mode", enum: ["a", "b"], default: "a" },
    token: {
      type: "string",
      title: "Token",
      writeOnly: true,
      reload: { shown: { when: "mode", equals: "b" } },
    },
    host: {
      type: "string",
      title: "Host",
      minLength: 3,
      reload: { shown: { when: "mode", equals: "b" } },
    },
    rows: {
      type: "array",
      title: "Rows",
      items: {
        type: "object",
        title: "row",
        required: ["path"],
        properties: {
          on: { type: "boolean", title: "On" },
          path: { type: "string", title: "Path", reload: { shown: { when: "on", equals: true } } },
        },
      },
    },
  },
};

beforeAll(() => {
  window.RED = { notify: () => undefined };
  const form = document.createElement("div");
  form.className = "reload-form";
  form.setAttribute("data-reload-type", TYPE);
  document.body.append(form);
  window.ReloadForms?.define(TYPE, CONFIG);
});

describe("a required property its condition hides", () => {
  it("is found hidden at every depth, and only problems about it are left out", () => {
    const value = { mode: "a", rows: [{ on: false }, { on: true }] };
    expect(hiddenPaths(CONFIG, value)).toEqual(["/token", "/host", "/rows/0/path"]);
    expect(hiddenPaths(CONFIG, { mode: "b", rows: "x" })).toEqual([]);
    // Its sibling left out is judged by its default ("a").
    expect(hiddenPaths(CONFIG, {})).toEqual(["/token", "/host"]);
    const problems = [
      { path: "/token" },
      { path: "/host/x" },
      { path: "/rows/1/path" },
      { path: "/hostname" },
    ];
    expect(unhidden(problems, ["/token", "/host"])).toEqual([
      { path: "/rows/1/path" },
      { path: "/hostname" },
    ]);
  });

  it("holds nothing back in the canvas form while hidden, and draws no reason beside it", () => {
    const forms = window.ReloadForms;
    if (forms === undefined) throw new Error("the form code did not load");
    const node = {
      id: "h1",
      mode: "a",
      host: "x",
      rows: [{ on: false }],
      credentials: { has_token: false },
    };
    for (const key of ["mode", "token", "host", "rows"]) {
      expect(forms.validate(TYPE, node, key)).toBe(true);
    }
    forms.prepare(TYPE, node);
    expect(document.querySelectorAll("[data-testid^='reload-error-']")).toHaveLength(0);
    // Shown again, its value is judged again.
    expect(forms.validate(TYPE, { ...node, mode: "b" }, "host")).toContain("Host");
    expect(forms.validate(TYPE, { ...node, rows: [{ on: true }] }, "rows")).toContain("Path");
  });

  it("leaves the step set up while hidden, and not set up once shown and unfilled", async () => {
    const type = {
      package: "demo",
      kind: "node",
      label: "Hidden",
      config: CONFIG,
    } as unknown as FlowNodeType;
    const deps = {
      engine: { secretsSet: () => Promise.resolve(new Set<string>()) },
      validator: new AjvSchemaValidator(),
    } as unknown as Parameters<typeof isSetUp>[2];
    const node = (mode: string) =>
      ({ id: "n", type: TYPE, z: "t", mode, rows: [] }) as unknown as TabNode;
    expect(await isSetUp(node("a"), type, deps)).toBe(true);
    expect(await isSetUp(node("b"), type, deps)).toBe(false);
  });
});
