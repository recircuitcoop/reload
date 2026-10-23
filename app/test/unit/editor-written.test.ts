// @vitest-environment happy-dom
//
// Who set a property, in the canvas form (adapters/nodered/editor-written.ts; spec 4.6,
// revision 2.2; plan 0032, WI-0032-41): a property its package set last says so beside it, a
// property only its package sets is drawn read-only with what it wrote, and the person's own
// changes are stamped, so their later change wins. Setup words the same note.

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
      written: { found: { by: "monty", at: AT }, shared: { by: "monty", at: AT } },
      set: [],
    };
    const fetched = vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer))));
    vi.stubGlobal("fetch", fetched);
    const node = {
      id: "n1",
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
      setBy("monty", AT),
    );
    // Either may set it: the package's later write says so, and it stays the person's to type.
    expect(form().querySelector("[data-testid='reload-written-shared']")?.textContent).toBe(
      setBy("monty", AT),
    );
    expect(field("shared").disabled).toBe(false);
    // The person's own property says nothing.
    expect(form().querySelector("[data-testid='reload-written-interval']")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps a package-only property as it was on a save, and stamps when the person changed theirs", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const node: Record<string, unknown> = { id: "n2", interval: 20, found: "before" };
    forms().prepare(TYPE, node);
    field("interval").value = "30";
    field("found").value = "typed over";
    forms().save(TYPE, node);
    expect(node["found"]).toBe("before");
    expect(node["interval"]).toBe("30");
    const stamps = node["reload.written"] as Record<string, string>;
    expect(Object.keys(stamps)).toEqual(["interval"]);
    expect(Math.abs(Date.parse(stamps["interval"] ?? "") - Date.now())).toBeLessThan(60_000);
    // A save that changes nothing stamps nothing more.
    forms().prepare(TYPE, node);
    forms().save(TYPE, node);
    expect(node["reload.written"]).toEqual(stamps);
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
