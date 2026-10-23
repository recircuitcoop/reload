// @vitest-environment happy-dom
//
// adapters/nodered/editor-read.ts in a DOM: the canvas form read back as Node-RED keeps it, each
// row remembering the stored row it was drawn from, a secret in a group saved to its
// credential as Node-RED saves its own inputs, and a secret no credential can hold found where
// something was typed into it (plan 0032 groups 1, 3 and 28).

import { describe, expect, it } from "vitest";

import { element } from "../../src/adapters/nodered/editor-options";
import {
  originOf,
  read,
  readRows,
  saveSecrets,
  SET,
  typedUnkept,
} from "../../src/adapters/nodered/editor-read";
import { formModel } from "../../src/domain/forms/form-model";

const { fields } = formModel({
  type: "object",
  properties: {
    label: { type: "string" },
    on: { type: "boolean" },
    mode: { enum: ["fast", "slow"] },
    notes: { type: "string", reload: { multiline: true } },
    root: { type: "string", reload: { path: "folder" } },
    formats: { type: "array", items: { enum: ["wav", "mp3"] }, uniqueItems: true },
    sizes: { type: "array", items: { type: "number" } },
    token: { type: "string", writeOnly: true },
    group: { type: "object", properties: { user: { type: "string" } } },
    rows: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
  },
});

/** A row as editor-forms.ts draws it: its label, then its control. */
function row(key: string, control: Element): HTMLElement {
  const line = element("div", { "data-reload-key": key });
  line.append(element("label", {}, key), control);
  return line;
}

function input(value: string, type = "text"): HTMLInputElement {
  const made = element("input", { type });
  made.value = value;
  return made;
}

describe("reading the form back", () => {
  it("reads every control as Node-RED keeps it, and never a secret", () => {
    const form = element("div");
    const on = input("", "checkbox");
    on.checked = true;
    const mode = element("select");
    mode.append(element("option", { value: "slow" }, "slow"));
    mode.value = "slow";
    const notes = element("textarea");
    notes.value = "one\ntwo";
    const root = element("div");
    root.append(input("/Volumes/a"), element("button"));
    const formats = element("div");
    const wav = input("", "checkbox");
    wav.setAttribute("data-reload-option", "0");
    const mp3 = input("", "checkbox");
    mp3.setAttribute("data-reload-option", "1");
    mp3.checked = true;
    formats.append(wav, mp3);
    const sizes = element("div");
    const first = element("div", { "data-reload-item": "sizes.0" });
    first.append(input("2"));
    sizes.append(first, element("button"));
    const group = element("fieldset");
    group.append(row("user", input("me")));
    const rows = element("div");
    const line = element("div", { "data-reload-row": "rows.0", "data-reload-origin": "4" });
    line.append(row("name", input("media")));
    const added = element("div", { "data-reload-row": "rows.1" });
    added.append(row("name", input("new")));
    rows.append(line, added, element("button"));
    form.append(
      row("label", input("L")),
      row("on", on),
      row("mode", mode),
      row("notes", notes),
      row("root", root),
      row("formats", formats),
      row("sizes", sizes),
      row("token", input("hunter2", "password")),
      row("group", group),
      row("rows", rows),
    );
    const values = read(form, fields);
    expect(values).toEqual({
      label: "L",
      on: true,
      mode: "slow",
      notes: "one\ntwo",
      root: "/Volumes/a",
      formats: ["mp3"],
      sizes: ["2"],
      group: { user: "me" },
      rows: [{ name: "media" }, { name: "new" }],
    });
    // Each row remembers the stored row it was drawn from; one added since remembers none.
    const [kept, fresh] = values["rows"] as object[];
    expect([originOf.get(kept as object), originOf.get(fresh as object)]).toEqual([4, undefined]);
    expect(readRows(element("div"), [])).toEqual([]);
    // A field drawn as nothing it can read is left out.
    const odd = element("div");
    odd.append(row("label", element("span")));
    expect(read(odd, fields)).toEqual({});
  });
});

describe("secrets in the form", () => {
  it("saves a secret drawn in a group to its credential, as Node-RED saves its own", () => {
    const form = element("div");
    const typed = input("pw", "password");
    typed.setAttribute("data-reload-secret", "account.password");
    const set = input(SET, "password");
    set.setAttribute("data-reload-secret", "account.key");
    const cleared = input("", "password");
    cleared.setAttribute("data-reload-secret", "account.old");
    const never = input("", "password");
    never.setAttribute("data-reload-secret", "account.never");
    form.append(typed, set, cleared, never);
    const node: Record<string, unknown> = {
      credentials: { "has_account.key": true, "has_account.old": true },
    };
    expect(saveSecrets(form, node)).toBe(true);
    expect(node["credentials"]).toEqual({
      "account.password": "pw",
      "has_account.password": true,
      "has_account.key": true,
      "account.old": "",
      "has_account.old": false,
    });
    expect(saveSecrets(element("div"), {})).toBe(false);
  });

  it("finds each secret no credential can hold that holds a typing", () => {
    const form = element("div");
    const typed = input("hunter2", "password");
    typed.setAttribute("data-reload-unkept", "volumes.0.key");
    const empty = input("", "password");
    empty.setAttribute("data-reload-unkept", "keys");
    form.append(typed, empty);
    expect(typedUnkept(form)).toEqual(["volumes.0.key"]);
  });
});
