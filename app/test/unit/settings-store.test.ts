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

  it("refuses an mcp setting it cannot read, a mistyped key named, and never ignores it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reload-settings-"));
    const file = path.join(dir, "settings.json");
    const store = new JsonSettingsStore(file);
    const stored = (mcp: unknown) => {
      fs.writeFileSync(file, JSON.stringify({ mcp }));
    };
    stored({ host: "127.0.0.1", port: 32010 });
    expect(store.readEndpoint()).toEqual({ host: "127.0.0.1", port: 32010 });
    stored({ address: "127.0.0.1" });
    expect(() => store.readEndpoint()).toThrow(
      `the mcp setting in ${file} holds unknown keys: address`,
    );
    stored({ host: 127 });
    expect(() => store.readEndpoint()).toThrow("must hold a host (text)");
    stored({ port: "32010" });
    expect(() => store.readEndpoint()).toThrow("a port (a whole number)");
    stored({ port: true });
    expect(() => store.readEndpoint()).toThrow("a port (a whole number)");
  });
});
