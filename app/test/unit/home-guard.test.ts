// The home guard is only worth anything while it can fail. Each test here makes it refuse or
// report something, and takes the leak back with collectLeaks() so the test itself passes.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  REAL_HOMES,
  SANDBOX_HOME,
  SANDBOX_VARIABLE,
  WriteToRealDirectory,
  collectLeaks,
} from "../home-guard";

/** A path in the real home that no test should ever create. */
function probeInRealHome(): string {
  const home = REAL_HOMES[0];
  if (home === undefined) {
    throw new Error("the guard knows no real home");
  }
  return path.join(home, `.reload-home-guard-probe-${String(process.pid)}`);
}

describe("the scratch home", () => {
  it("is where os.homedir() and the XDG variables point", () => {
    expect(os.homedir()).toBe(SANDBOX_HOME);
    expect(process.env[SANDBOX_VARIABLE]).toBe(SANDBOX_HOME);
    expect(process.env["XDG_CONFIG_HOME"]).toBe(path.join(SANDBOX_HOME, ".config"));
    expect(REAL_HOMES).not.toContain(SANDBOX_HOME);
  });

  it("reports a file a test left in it, then empties it", () => {
    mkdirSync(path.join(SANDBOX_HOME, ".config", "reload"), { recursive: true });
    writeFileSync(path.join(SANDBOX_HOME, ".config", "reload", "settings.json"), "{}");

    const leaks = collectLeaks();

    expect(leaks).toContain(`written: ~/${path.join(".config", "reload", "settings.json")}`);
    expect(fs.readdirSync(SANDBOX_HOME)).toEqual([]);
  });
});

describe("the real home", () => {
  it("refuses a synchronous write, before it reaches the disk", () => {
    const probe = probeInRealHome();

    expect(() => {
      writeFileSync(probe, "x");
    }).toThrow(WriteToRealDirectory);

    expect(fs.existsSync(probe)).toBe(false);
    expect(collectLeaks()).toEqual([`refused: fs.writeFileSync ${probe}`]);
  });

  it("rejects a promise-based write and a mkdir", async () => {
    const probe = probeInRealHome();

    await expect(fsp.writeFile(probe, "x")).rejects.toThrow(WriteToRealDirectory);
    await expect(fsp.mkdir(probe)).rejects.toThrow(WriteToRealDirectory);

    expect(fs.existsSync(probe)).toBe(false);
    expect(collectLeaks()).toEqual([
      `refused: fs.writeFile ${probe}`,
      `refused: fs.mkdir ${probe}`,
    ]);
  });

  it("refuses opening for writing, and allows opening for reading", () => {
    const probe = probeInRealHome();

    expect(() => fs.openSync(probe, "w")).toThrow(WriteToRealDirectory);
    expect(collectLeaks()).toEqual([`refused: fs.openSync ${probe}`]);

    // Reading is not a leak: the refusal is about changing the home, not looking at it.
    expect(() => fs.openSync(probe, "r")).toThrow(/ENOENT/);
    expect(collectLeaks()).toEqual([]);
  });

  it("still fails the test when the code under test swallows the refusal", () => {
    const probe = probeInRealHome();

    try {
      fs.appendFileSync(probe, "x");
    } catch {
      // What production code that "handles" a failed write would do.
    }

    expect(collectLeaks()).toEqual([`refused: fs.appendFileSync ${probe}`]);
  });

  it("leaves the temp directory writable", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-guard-"));
    writeFileSync(path.join(scratch, "file"), "x");
    fs.rmSync(scratch, { recursive: true });

    expect(collectLeaks()).toEqual([]);
  });
});

describe("a child process started with the inherited environment", () => {
  /** Run `script` in a Node child that inherits this test's environment, as a test would. */
  function child(script: string): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  }

  it("is refused a write it spells out into the real home, and the test that started it fails", () => {
    const probe = probeInRealHome();

    // The child swallows the refusal and exits 0: what it leaves on record still fails the test.
    const run = child(
      `try { require("node:fs").writeFileSync(${JSON.stringify(probe)}, "x"); } ` +
        `catch (error) { process.stdout.write(error.name); }`,
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("WriteToRealDirectory");
    expect(fs.existsSync(probe)).toBe(false);
    expect(collectLeaks()).toEqual([
      `refused: fs.writeFileSync ${probe} (child process ${String(run.pid)})`,
    ]);
  });

  it("is refused through an ESM import of node:fs and the promise API too", () => {
    const probe = probeInRealHome();

    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { mkdirSync } from "node:fs"; import { writeFile } from "node:fs/promises";` +
          `try { mkdirSync(${JSON.stringify(probe)}); } catch {}` +
          `await writeFile(${JSON.stringify(probe)}, "x").catch(() => {});`,
      ],
      { encoding: "utf8" },
    );

    expect(run.status).toBe(0);
    expect(fs.existsSync(probe)).toBe(false);
    expect(collectLeaks()).toEqual([
      `refused: fs.mkdirSync ${probe} (child process ${String(run.pid)})`,
      `refused: fs.writeFile ${probe} (child process ${String(run.pid)})`,
    ]);
  });

  it("writing where production code looks lands in the scratch home, and is reported", () => {
    const run = child(
      `const p = require("node:path").join(require("node:os").homedir(), ".config", "reload");` +
        `require("node:fs").mkdirSync(p, { recursive: true });` +
        `require("node:fs").writeFileSync(require("node:path").join(p, "settings.json"), "{}");`,
    );

    expect(run.status).toBe(0);
    expect(collectLeaks()).toContain(
      `written: ~/${path.join(".config", "reload", "settings.json")}`,
    );
  });

  it("may still write in the temp directory", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-guard-"));

    const run = child(
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(scratch, "file"))}, "x")`,
    );

    expect(run.status).toBe(0);
    expect(fs.readFileSync(path.join(scratch, "file"), "utf8")).toBe("x");
    fs.rmSync(scratch, { recursive: true });
    expect(collectLeaks()).toEqual([]);
  });
});
