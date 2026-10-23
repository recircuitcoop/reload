// @vitest-environment happy-dom
//
// adapters/nodered/editor-forms.ts as Node-RED loads it: the editor's Deploy is set to deploy
// only the modified nodes, so saving one step's setting restarts that step's process alone, as
// the old app restarted only the plugin whose setting changed (plan 0032, group 37). Node-RED
// draws its deploy menu before it loads any node's definition, so the menu is there to set.

import { describe, expect, it, vi } from "vitest";

describe("the editor's Deploy", () => {
  it("deploys the modified nodes only, once the form code loads", async () => {
    const setSelected = vi.fn();
    window.RED = { notify: () => undefined, menu: { setSelected } };
    await import("../../src/adapters/nodered/editor-forms");
    expect(setSelected).toHaveBeenCalledWith("deploymenu-item-node", true);
  });
});
