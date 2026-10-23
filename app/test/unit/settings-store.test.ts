// JsonSettingsStore's reading of its file (adapters/fs/settings-store.ts).
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";

describe("JsonSettingsStore", () => {
  let dir = "";
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a file that is not UTF-8 by name, and never writes over it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reload-settings-"));
    const file = path.join(dir, "shell-settings.json");
    // Valid JSON once decoded loosely: the bad bytes sit inside a string.
    const bytes = Buffer.concat([
      Buffer.from('{"setup":{"note":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}}'),
    ]);
    fs.writeFileSync(file, bytes);
    const store = new JsonSettingsStore(file);
    expect(() => store.readSetup()).toThrow(`${file} is not UTF-8 text`);
    expect(() => {
      store.writeSetup({ step: "reports" });
    }).toThrow(`${file} is not UTF-8 text`);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });
});
