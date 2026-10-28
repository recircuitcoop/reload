// "Tell AI apps the names of my spaces" (plan 0033 D2): the stored switch, its gate in front of
// the live names, and what the instructions and tool descriptions carry with it on and off.

import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { gatedSpaceNames, serveSpaceNamesCall } from "../../src/application/space-names";
import { intentTools } from "../../src/domain/anytype/intent-tools";
import {
  composeServerInstructions,
  type SpaceNames,
} from "../../src/domain/anytype/server-instructions";
import { withToolMetadata } from "../../src/domain/anytype/tool-classes";
import type { SpaceNamesSetting } from "../../src/ports/settings-store";

const NAMES = ["Garden Notes", "Tax 2026"];

function tempStore(): { file: string; store: JsonSettingsStore } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reload-settings-")), "s.json");
  return { file, store: new JsonSettingsStore(file) };
}

function memory(on: boolean): SpaceNamesSetting & { on: boolean } {
  const setting = {
    on,
    readSpaceNames: () => setting.on,
    writeSpaceNames: (next: boolean) => {
      setting.on = next;
    },
  };
  return setting;
}

/** Everything a connection is sent that could carry names: initialize and tools/list. */
function sent(spaces: SpaceNames): string {
  const raw = ["API-list-spaces", "API-search-space", "API-search-global"].map((name) =>
    withToolMetadata({ name, description: "Anytype's own text." }, spaces),
  );
  return JSON.stringify([composeServerInstructions(spaces), raw, intentTools(spaces)]);
}

describe("the stored switch", () => {
  it("is on when nothing is stored, and kept beside the other settings", () => {
    const { file, store } = tempStore();
    expect(store.readSpaceNames()).toBe(true);
    store.writeLaunchAtLogin(true);
    store.writeSpaceNames(false);
    expect(store.readSpaceNames()).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      launchAtLogin: true,
      spaceNamesToAiApps: false,
    });
  });

  it("refuses a value that is not true or false", () => {
    const { file, store } = tempStore();
    fs.writeFileSync(file, JSON.stringify({ spaceNamesToAiApps: "no" }));
    expect(() => store.readSpaceNames()).toThrow(/must be true or false/);
  });
});

describe("the gate in front of the live names", () => {
  it("on, answers the live names", async () => {
    const names = gatedSpaceNames(memory(true), () => Promise.resolve(NAMES));
    expect(await names()).toEqual(NAMES);
  });

  it("off, answers withheld without asking Anytype, from the next call", async () => {
    const setting = memory(true);
    let asked = 0;
    const names = gatedSpaceNames(setting, () => {
      asked += 1;
      return Promise.resolve(NAMES);
    });
    await names();
    setting.on = false;
    expect(await names()).toBe("withheld");
    expect(asked).toBe(1);
  });
});

describe("what a connection is sent", () => {
  it("on, carries the names in the instructions and the list and search descriptions", () => {
    const text = sent(NAMES);
    for (const name of NAMES) {
      expect(text).toContain(name);
    }
    expect(composeServerInstructions(NAMES)).toContain("Garden Notes");
  });

  it("off, carries no name anywhere, and the instructions keep what it is and when", () => {
    const text = sent("withheld");
    for (const name of NAMES) {
      expect(text).not.toContain(name);
    }
    const instructions = composeServerInstructions("withheld");
    expect(instructions).not.toMatch(/spaces are:|could not be listed/);
    expect(instructions).toContain("the user's own Anytype");
  });
});

describe("the page's calls", () => {
  it("reads and moves the switch, and refuses anything but a boolean", () => {
    const setting = memory(true);
    expect(serveSpaceNamesCall(setting, "spaceNames.get", null)).toEqual({ ok: true, value: true });
    expect(serveSpaceNamesCall(setting, "spaceNames.set", { on: false })).toEqual({
      ok: true,
      value: false,
    });
    expect(serveSpaceNamesCall(setting, "spaceNames.set", { on: "yes" })).toMatchObject({
      ok: false,
    });
    expect(setting.on).toBe(false);
  });
});
