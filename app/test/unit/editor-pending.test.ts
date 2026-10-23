// @vitest-environment happy-dom
//
// adapters/nodered/editor-forms.ts as Node-RED loads it: definitions put in the page before the
// form code are defined as it loads, each on its own, so one whose form cannot be built is said
// and never costs the types after it.

import { describe, expect, it, vi } from "vitest";

describe("definitions waiting for the form code", () => {
  it("are each defined alone: a broken one is said, and the next still has its form", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.ReloadFormsPending = [
      ["reload-demo-broken", { type: "object", properties: { x: { type: 5 } } }],
      [
        "reload-demo-fine",
        { type: "object", properties: { label: { type: "string", minLength: 2 } } },
      ],
    ];
    await import("../../src/adapters/nodered/editor-forms");
    const forms = window.ReloadForms;
    if (forms === undefined) throw new Error("the form code did not load");
    expect(forms.validate("reload-demo-fine", { label: "ok" }, "label")).toBe(true);
    expect(forms.validate("reload-demo-fine", { label: "x" }, "label")).toContain(
      "must be at least 2",
    );
    expect(() => forms.validate("reload-demo-broken", {}, "x")).toThrow(/no form is defined/);
    expect(said).toHaveBeenCalledWith(
      expect.stringContaining("Reload: the form of reload-demo-broken could not be built"),
    );
    said.mockRestore();
  });
});
