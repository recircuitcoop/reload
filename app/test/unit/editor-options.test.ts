// @vitest-environment happy-dom
//
// adapters/nodered/editor-options.ts in a DOM: the canvas form's elements, its rows found only
// where they belong, and its options read from Anytype (plan 0022 §B): spaces read as the form
// opens, a space's types read again when another space is chosen, the stored value never
// dropped, and a slow answer for a space no longer chosen never shown.

import { afterEach, describe, expect, it, vi } from "vitest";

import { element, rowOf, showSelect, wireOptions } from "../../src/adapters/nodered/editor-options";
import { formModel } from "../../src/domain/forms/form-model";

const { fields } = formModel({
  type: "object",
  properties: {
    space: { type: "string", title: "Space", reload: { spaces: true } },
    type: { type: "string", title: "Type", reload: { types: { of: "space" } } },
    plain: { type: "string" },
  },
});

/** A row as editor-forms.ts draws it: its label, its control, then its note. */
function row(key: string, control: HTMLElement): HTMLElement {
  const line = element("div", { "data-reload-key": key });
  line.append(element("label", {}, key), control, element("div", { "data-reload-note": key }));
  return line;
}

/** A select holding `value`, as a stored value is offered before any answer. */
function select(value: string): HTMLSelectElement {
  const made = element("select");
  made.append(element("option", { value }, value));
  made.value = value;
  return made;
}

/** Answers for the options route, by its query; each held until `release` when asked to. */
function answering(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  vi.stubGlobal("fetch", (url: string) => {
    asked.push(url);
    const body = answers[url.slice(url.indexOf("?") + 1)];
    const response = Promise.resolve({ json: () => Promise.resolve(body) });
    if (!hold) {
      return body === undefined ? Promise.reject(new Error("unreachable")) : response;
    }
    return new Promise((resolve) =>
      held.push(() => {
        resolve(response);
      }),
    );
  });
  return {
    asked,
    holding: (on: boolean) => {
      hold = on;
    },
    release: () => {
      for (const resume of held.splice(0)) {
        resume();
      }
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const labels = (made: HTMLSelectElement) => [...made.options].map((option) => option.text);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the form's elements", () => {
  it("makes an element with its attributes and its text", () => {
    const made = element("button", { type: "button", "data-x": "1" }, "Add");
    expect([made.tagName, made.getAttribute("data-x"), made.textContent]).toEqual([
      "BUTTON",
      "1",
      "Add",
    ]);
    expect(element("div").textContent).toBe("");
  });

  it("finds a row directly under its form or in its own Advanced, never deeper", () => {
    const form = element("div");
    const advanced = element("details", { "data-reload-advanced": "" });
    const nested = element("div");
    nested.append(row("deep", element("input")));
    advanced.append(row("folded", element("input")));
    form.append(row("top", element("input")), advanced, nested);
    expect(rowOf(form, "top")?.getAttribute("data-reload-key")).toBe("top");
    expect(rowOf(form, "folded")?.getAttribute("data-reload-key")).toBe("folded");
    expect(rowOf(form, "deep")).toBeNull();
    expect(rowOf(element("div"), "top")).toBeNull();
  });

  it("draws a select as its model says, with its note's sentence or none", () => {
    const line = row("space", select(""));
    const made = line.children[1] as HTMLSelectElement;
    const note = line.children[2] as HTMLElement;
    const options = [
      { value: "", label: "" },
      { value: "s1", label: "Work" },
    ];
    showSelect(made, { options, value: "s1", disabled: false, sentence: null });
    expect([labels(made), made.value, made.disabled, note.hidden]).toEqual([
      ["", "Work"],
      "s1",
      false,
      true,
    ]);
    showSelect(made, { options, value: "", disabled: true, sentence: "Reading your spaces…" });
    expect([made.disabled, note.textContent, note.hidden]).toEqual([
      true,
      "Reading your spaces…",
      false,
    ]);
    // A select with no note of its own is drawn all the same.
    const alone = select("");
    showSelect(alone, { options, value: "s1", disabled: false, sentence: "said nowhere" });
    expect(alone.value).toBe("s1");
  });
});

describe("options read from Anytype", () => {
  it("reads the spaces, then the chosen space's types, keeping a stored value", async () => {
    const route = answering({
      "source=spaces": { options: [{ value: "s1", label: "Work" }] },
      "source=types&space=s1": { options: [{ value: "page", label: "Page" }] },
      "source=types&space=s2": { options: [{ value: "task", label: "Task" }] },
    });
    const form = element("div");
    form.append(
      row("space", select("s1")),
      row("type", select("note")),
      row("plain", element("input")),
    );
    wireOptions(form, fields);
    const space = form.querySelector("[data-reload-key=space] select") as HTMLSelectElement;
    const type = form.querySelector("[data-reload-key=type] select") as HTMLSelectElement;
    expect(space.disabled).toBe(true);
    await settle();
    expect(labels(space)).toEqual(["", "Work"]);
    // "note" is no type of the space, and is offered under its own text, so a save keeps it.
    expect([labels(type), type.value]).toEqual([["", "Page", "note"], "note"]);
    expect(route.asked).toEqual([
      "reload/options?source=spaces",
      "reload/options?source=types&space=s1",
    ]);
    // Another space: its types are read again, and a type it lacks is cleared.
    space.append(element("option", { value: "s2" }, "Home"));
    space.value = "s2";
    space.dispatchEvent(new Event("change"));
    await settle();
    expect([labels(type), type.value]).toEqual([["", "Task"], ""]);
  });

  it("waits for a space, shows a refusal's sentence, and drops a slow answer superseded", async () => {
    const route = answering({
      "source=spaces": { refused: { reason: "not-paired" } },
      "source=types&space=s1": { options: [{ value: "page", label: "Page" }] },
      "source=types&space=s2": { options: [{ value: "task", label: "Task" }] },
    });
    const form = element("div");
    form.append(row("space", select("")), row("type", select("")));
    wireOptions(form, fields);
    const space = form.querySelector("[data-reload-key=space] select") as HTMLSelectElement;
    const type = form.querySelector("[data-reload-key=type] select") as HTMLSelectElement;
    await settle();
    // No space chosen: the types wait, empty and disabled.
    expect([labels(type), type.disabled]).toEqual([[""], true]);
    const note = form.querySelector("[data-reload-note=space]") as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).not.toBe("");
    // Two spaces chosen in turn: only the newest answer is drawn.
    route.holding(true);
    space.append(
      element("option", { value: "s1" }, "s1"),
      element("option", { value: "s2" }, "s2"),
    );
    space.value = "s1";
    space.dispatchEvent(new Event("change"));
    space.value = "s2";
    space.dispatchEvent(new Event("change"));
    route.release();
    await settle();
    expect(labels(type)).toEqual(["", "Task"]);
  });

  it("says Anytype cannot be read when the route cannot be reached", async () => {
    answering({});
    const form = element("div");
    form.append(row("space", select("s1")));
    wireOptions(form, fields);
    await settle();
    const space = form.querySelector("[data-reload-key=space] select") as HTMLSelectElement;
    expect([labels(space), space.value, space.disabled]).toEqual([["", "s1"], "s1", true]);
  });
});
