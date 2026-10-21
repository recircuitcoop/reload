// The home guard is only worth anything while it can fail. Each test here makes it refuse or
// report something, and takes the leak back with collectLeaks() so the test itself passes.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

import { logPath } from "../../src/adapters/fs/log-writer";
import { rawNodeEnv } from "../fixtures/raw-node/fixture";

import {
  GUARD_VARIABLES,
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

/** Where the production log writer puts the log, for a home. */
function location(home: string) {
  return { platform: process.platform, home, env: {} };
}

let bundled: string | null = null;

/**
 * A script that writes one line through the production log writer at its default path, worked
 * out from os.homedir() as the shell does (shell/main.ts): the way the old leaks happened.
 */
function productionLogWriter(): string {
  if (bundled !== null) {
    return bundled;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reload-guard-writer-"));
  const entry = path.join(dir, "entry.ts");
  const source = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "src",
    "adapters",
    "fs",
    "log-writer.ts",
  );
  fs.writeFileSync(
    entry,
    `import * as os from "node:os";\n` +
      `import { logPath, RotatingLogFile } from ${JSON.stringify(source)};\n` +
      `const file = logPath({ platform: process.platform, home: os.homedir(), env: {} });\n` +
      `RotatingLogFile.open(file)?.append("a line");\n`,
  );
  bundled = path.join(dir, "writer.cjs");
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundled,
    logLevel: "silent",
  });
  return bundled;
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

  it("writing through the production log writer, at its default path, lands in the scratch home and is reported", () => {
    const run = spawnSync(process.execPath, [productionLogWriter()], { encoding: "utf8" });

    expect(run.status).toBe(0);
    const log = path.relative(SANDBOX_HOME, logPath(location(SANDBOX_HOME)));
    expect(collectLeaks()).toContain(`written: ~/${log}`);
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

describe("a child process started with an environment of its own", () => {
  it("a Node child given {} writes through the production log writer into the real home: refused", () => {
    // With no HOME at all, os.homedir() falls back to the account's real home.
    const real = logPath(location(os.userInfo().homedir));
    const before = fs.existsSync(real) ? fs.statSync(real).size : null;
    const run = spawnSync(process.execPath, [productionLogWriter()], { env: {}, encoding: "utf8" });

    // The production writer swallows the failure, as it should: the record still fails the test.
    expect(run.status).toBe(0);
    // The real log, where this machine's own Reload writes, is untouched.
    expect(fs.existsSync(real) ? fs.statSync(real).size : null).toBe(before);
    const leaks = collectLeaks();
    expect(leaks.length).toBeGreaterThan(0);
    expect(
      leaks.every(
        (leak) =>
          leak.startsWith("refused: fs.") && leak.includes(`(child process ${String(run.pid)})`),
      ),
    ).toBe(true);
  });

  it("a Python child given the node adapter's minimal environment is refused a real-home write", () => {
    const probe = probeInRealHome();
    const run = spawnSync(
      "python3",
      [
        "-c",
        `import os\ntry:\n    open(${JSON.stringify(probe)}, "w").write("x")\nexcept PermissionError as e:\n    print(e)\n`,
      ],
      { env: rawNodeEnv(), encoding: "utf8" },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("WriteToRealDirectory");
    expect(fs.existsSync(probe)).toBe(false);
    expect(collectLeaks()).toEqual([
      `refused: python open ${probe} (child process ${String(run.pid)})`,
    ]);
  });

  it("a Python child that removes, renames or makes a directory in the real home is refused each", () => {
    const probe = probeInRealHome();
    const run = spawnSync(
      "python3",
      [
        "-c",
        [
          "import os, shutil",
          `for act in (lambda: os.mkdir(${JSON.stringify(probe)}), lambda: os.remove(${JSON.stringify(probe)}), lambda: os.rename(${JSON.stringify(probe)}, ${JSON.stringify(`${probe}-2`)}), lambda: shutil.rmtree(${JSON.stringify(probe)})):`,
          "    try:",
          "        act()",
          "    except (PermissionError, FileNotFoundError):",
          "        pass",
        ].join("\n"),
      ],
      { env: rawNodeEnv(), encoding: "utf8" },
    );

    expect(run.status).toBe(0);
    const leaks = collectLeaks();
    for (const event of ["os.mkdir", "os.remove", "os.rename", "shutil.rmtree"]) {
      expect(leaks).toContain(
        `refused: python ${event} ${probe} (child process ${String(run.pid)})`,
      );
    }
  });

  it("an environment that already holds the guard, or a PYTHONPATH of its own, keeps both", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify([process.env.PYTHONPATH, process.env.NODE_OPTIONS]))",
      ],
      { env: { ...process.env, PYTHONPATH: "/somewhere" }, encoding: "utf8" },
    );

    const [pythonPath, nodeOptions] = JSON.parse(run.stdout) as [string, string];
    expect(pythonPath.split(path.delimiter)).toHaveLength(2);
    expect(pythonPath.endsWith(`${path.delimiter}/somewhere`)).toBe(true);
    expect(nodeOptions.match(/home-guard-child\.cjs/g)).toHaveLength(1);
    expect(GUARD_VARIABLES).toContain("PYTHONPATH");
  });
});
