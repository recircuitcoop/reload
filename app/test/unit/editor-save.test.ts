// @vitest-environment happy-dom
//
// adapters/nodered/editor-forms.ts's own save(), in a DOM: a secret typed into a field whose
// schema holds one in a shape the forms do not draw (a package read refuses such a shape; this
// is the net behind it) reaches neither the node's plain properties, nor the refusal kept on the
// node (`reload.refused`, written into flows.json), nor the notice the editor shows.

import { beforeAll, describe, expect, it } from "vitest";

import "../../src/adapters/nodered/editor-forms";

const TYPE = "reload-demo-odd";
const SECRET = "hunter2-editor-save";

const schema = {
  type: "object",
  properties: {
    label: { type: "string", title: "Label", minLength: 2 },
    odd: { type: ["array", "null"], title: "Odd", items: { type: "string", writeOnly: true } },
    either: { title: "Either", anyOf: [{ type: "string", writeOnly: true }, { type: "null" }] },
  },
};

const notices: string[] = [];

beforeAll(() => {
  window.RED = { notify: (message: string) => notices.push(message) };
  const form = document.createElement("div");
  form.className = "reload-form";
  form.setAttribute("data-reload-type", TYPE);
  document.body.append(form);
  window.ReloadForms?.define(TYPE, schema);
});

/** The input drawn for `path` in the open form. */
function field(path: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`[data-reload-field="${path}"]`);
  if (found === null) {
    throw new Error(`no field ${path}`);
  }
  return found;
}

describe("the canvas form's save", () => {
  it("keeps no secret, at any depth, in the node, its kept refusal or the notice", () => {
    const forms = window.ReloadForms;
    if (forms === undefined) throw new Error("the form code did not load");
    const node: Record<string, unknown> = { id: "n1", label: "ok" };
    forms.prepare(TYPE, node);
    field("label").value = "x"; // refused: too short, so a refusal is kept
    field("odd").value = SECRET;
    field("either").value = SECRET;
    forms.save(TYPE, node);
    expect(node["label"]).toBe("ok");
    expect(node["reload.refused"]).not.toBeNull();
    expect(JSON.stringify(node)).not.toContain(SECRET);
    expect(notices.join(" ")).toContain("Label: must be at least 2 characters long");
    expect(notices.join(" ")).not.toContain(SECRET);
  });
});
