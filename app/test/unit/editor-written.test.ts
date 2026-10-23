// @vitest-environment happy-dom
//
// Who set a property, in the canvas form (adapters/nodered/editor-written.ts; spec 4.6,
// revision 2.3; plan 0032, WI-0032-41): a property whose value in force is its package's shows
// that value and says so beside it, a property only its package sets is drawn read-only, and
// the package's value sent back unchanged stays the node's own, never the person's. The
// person's change is stamped at the deploy (guard-middleware, kept-undeclared.test.ts), not at
// Done. Setup words the same note.

import { beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/adapters/nodered/editor-forms";
import { setBy } from "../../src/adapters/nodered/editor-written";
import { setupFields } from "../../src/ui/setup-form";
import { wordSetBy } from "../../src/ui/words";

const TYPE = "reload-demo-written";
const SCHEMA = {
  type: "object",
  properties: {
    interval: { type: "integer", title: "Interval" },
    found: { type: "string", title: "Found", reload: { writtenBy: "plugin" } },
    shared: { type: "string", title: "Shared", reload: { writtenBy: "both" } },
  },
};
const AT = "2026-10-23T10:00:00.000Z";

beforeAll(() => {
  window.RED = { notify: () => undefined };
  const form = document.createElement("div");
  form.className = "reload-form";
  form.setAttribute("data-reload-type", TYPE);
  document.body.append(form);
  window.ReloadForms?.define(TYPE, SCHEMA);
});

function forms(): NonNullable<Window["ReloadForms"]> {
  const loaded = window.ReloadForms;
  if (loaded === undefined) throw new Error("the form code did not load");
  return loaded;
}

const form = () =>
  document.querySelector<HTMLElement>(`.reload-form[data-reload-type="${TYPE}"]`) as HTMLElement;
const field = (key: string) =>
  form().querySelector<HTMLInputElement>(`[data-reload-field="${key}"]`) as HTMLInputElement;

describe("a property its package set, in the canvas form", () => {
  it("is drawn read-only with what the package wrote, and says who set it and when", async () => {
    const answer = {
      values: { found: "/found-by-monty", shared: "theirs" },
      written: { found: { by: "demo", at: AT }, shared: { by: "demo", at: AT } },
      set: [],
    };
    const fetched = vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer))));
    vi.stubGlobal("fetch", fetched);
    const node = {
      id: "n1",
      type: TYPE,
      interval: 20,
      found: "",
      shared: "mine",
      "reload.written": { shared: "2026-10-23T09:00:00.000Z" },
    };
    forms().prepare(TYPE, node);
    await vi.waitFor(() => {
      expect(form().querySelector("[data-testid='reload-written-found']")).not.toBeNull();
    });
    expect(fetched).toHaveBeenCalledWith("reload/written?node=n1", { cache: "no-store" });
    expect(field("found").disabled).toBe(true);
    expect(field("found").value).toBe("/found-by-monty");
    expect(form().querySelector("[data-testid='reload-written-found']")?.textContent).toBe(
      setBy("demo", AT),
    );
    // Either may set it: the package's later write says so, and it stays the person's to type.
    expect(form().querySelector("[data-testid='reload-written-shared']")?.textContent).toBe(
      setBy("demo", AT),
    );
    expect(field("shared").disabled).toBe(false);
    // The value in force is the package's later one: shown, not the node's older own.
    expect(field("shared").value).toBe("theirs");
    // Sent back unchanged, it stays the package's: the node keeps its own.
    forms().save(TYPE, node);
    expect(node.shared).toBe("mine");
    expect(node["reload.written"]).toEqual({ shared: "2026-10-23T09:00:00.000Z" });
    // The person's own property says nothing.
    expect(form().querySelector("[data-testid='reload-written-interval']")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps a package-only property as it was on a save, and stamps nothing at Done", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const node: Record<string, unknown> = { id: "n2", type: TYPE, interval: 20, found: "before" };
    forms().prepare(TYPE, node);
    field("interval").value = "30";
    field("found").value = "typed over";
    forms().save(TYPE, node);
    expect(node["found"]).toBe("before");
    expect(node["interval"]).toBe("30");
    // When it takes effect is the deploy's to say, not this Done's.
    expect(node["reload.written"]).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("a property its package set, in Setup", () => {
  it("is shown never typed over when only its package sets it, and is said to be set by it", () => {
    const fields = setupFields(SCHEMA);
    expect(fields.map((each) => [each.key, each.readOnly])).toEqual([
      ["interval", false],
      ["found", true],
      ["shared", false],
    ]);
    const now = new Date(AT);
    expect(wordSetBy("monty", now, now)).toMatch(/^Set by monty, today \d\d:\d\d$/);
  });
});
