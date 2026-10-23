// adapters/process/command.ts and process-tree.ts: argv, working directory and environment
// of a node process (spec 2.3, plan 0018 §7), and ending its tree.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CommandError,
  commandFor,
  minimalEnvironment,
  resolveCommand,
  substitute,
  unpackedDir,
} from "../../src/adapters/process/command";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { watchExit } from "../../src/adapters/process/exit-watch";
import { processTreeFor } from "../../src/adapters/process/process-tree";
import type { CommandRunner } from "../../src/adapters/process/resource-probe";

const VALUES = { python: "/env/bin/python", node: "/app/node", package: "/pkgs/monty" };

describe("the declared command", () => {
  it("is the bare array on every platform", () => {
    expect(commandFor(["a", "b"], "linux")).toEqual(["a", "b"]);
  });

  it("is the platform's own argv, else default, else refused", () => {
    const table = { darwin: ["mac"], default: ["any"] };
    expect(commandFor(table, "darwin")).toEqual(["mac"]);
    expect(commandFor(table, "linux")).toEqual(["any"]);
    expect(commandFor(table, "freebsd")).toEqual(["any"]);
    expect(() => commandFor({ win32: ["w"] }, "linux")).toThrow(
      /declares nothing for linux and no default/,
    );
  });
});

describe("placeholders", () => {
  it("substitutes {python}, {node} and {package}, and {{ is a literal {", () => {
    expect(substitute("{python}", VALUES)).toBe("/env/bin/python");
    expect(substitute("{package}/x.py", VALUES)).toBe("/pkgs/monty/x.py");
    expect(substitute("--node={node}", VALUES)).toBe("--node=/app/node");
    expect(substitute("{{json}}", VALUES)).toBe("{json}}");
    expect(substitute("plain", VALUES)).toBe("plain");
  });

  it("refuses any other placeholder or a lone {", () => {
    expect(() => substitute("{pyhton}", VALUES)).toThrow(CommandError);
    expect(() => substitute("a{b", VALUES)).toThrow(
      /unknown placeholder in "a\{b"; write \{ as \{\{/,
    );
  });

  it("resolves the argv and the working directory, both on the unpacked package", () => {
    const packed = path.join(
      "/Applications/Reload.app/Contents/Resources/app.asar",
      "packages",
      "monty",
    );
    const resolved = resolveCommand(["{python}", "{package}/run.py"], "darwin", {
      ...VALUES,
      package: packed,
    });
    const unpacked = unpackedDir(packed);
    expect(unpacked).toContain(`app.asar.unpacked${path.sep}packages`);
    expect(resolved).toEqual({ argv: ["/env/bin/python", `${unpacked}/run.py`], cwd: unpacked });
    expect(unpackedDir("/pkgs/monty")).toBe("/pkgs/monty");
  });

  it("turns the packaged Anytype MCP entry into the file the bundled Node can read (0.2.0's MODULE_NOT_FOUND)", () => {
    // The exact argv 0.2.0's services process logged before every start of the child failed:
    // plain Node cannot read inside app.asar.
    const packed =
      "/Applications/Reload.app/Contents/Resources/app.asar/node_modules/@anyproto/anytype-mcp/bin/cli.mjs";
    expect(unpackedDir(packed)).toBe(
      "/Applications/Reload.app/Contents/Resources/app.asar.unpacked/node_modules/@anyproto/anytype-mcp/bin/cli.mjs",
    );
    // services/main.ts imports Electron's parentPort at load, so its wiring is read, not run:
    // the pinned entry goes through unpackedDir before it reaches the launcher.
    const servicesRoot = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "services", "main.ts"),
      "utf8",
    );
    expect(servicesRoot).toContain("unpackedDir(pinnedPackageEntry(require.resolve))");
  });

  it("refuses an empty command", () => {
    expect(() => resolveCommand([], "darwin", VALUES)).toThrow(/the command is empty/);
    expect(() => resolveCommand(["{{"].slice(1), "darwin", VALUES)).toThrow(CommandError);
  });

  it("refuses npm and npx by name, whatever declared it or how it is spelled (WI-0018-23)", () => {
    expect(() => resolveCommand(["npm", "install"], "darwin", VALUES)).toThrow(
      /npm is not in the bundle \(WI-0018-23\)/,
    );
    expect(() => resolveCommand(["npx", "cowsay"], "linux", VALUES)).toThrow(
      /npx is not in the bundle \(WI-0018-23\)/,
    );
    // A full path, or Windows' launcher extension, is still npm: the check is by basename.
    expect(() => resolveCommand(["/usr/local/bin/npm"], "linux", VALUES)).toThrow(CommandError);
    expect(() => resolveCommand(["npm.cmd"], "win32", VALUES)).toThrow(CommandError);
    // A package that merely names something starting with npm is not npm.
    expect(() => resolveCommand(["npm-check-updates"], "linux", VALUES)).not.toThrow();
  });
});

describe("the minimal environment", () => {
  it("keeps only the allow-listed variables, adds the node defaults, then the caller's", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANYTYPE_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      LANG: undefined,
    };
    expect(minimalEnvironment(parent, { PATH: "/venv/bin:/usr/bin" })).toEqual({
      PATH: "/venv/bin:/usr/bin",
      HOME: "/home/me",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    });
    expect(minimalEnvironment({})).toEqual({ PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
  });
});

describe("the process tree", () => {
  it("on POSIX is a detached group: asked to stop as a group, and a forced end ends the node itself", () => {
    const signals: [number, string][] = [];
    const tree = processTreeFor("darwin", (pid, signal) => signals.push([pid, signal]));
    expect(tree.detached).toBe(true);
    expect(tree.blocked).toBeNull();
    tree.kill(42);
    tree.stop(42);
    // What the node started is the sweep's after its exit: politely first, never killed outright.
    expect(signals).toEqual([
      [42, "SIGKILL"],
      [-42, "SIGTERM"],
    ]);
  });

  it("on Windows is BLOCKED for WI-0025-01 and ends only the process", () => {
    const signals: [number, string][] = [];
    const tree = processTreeFor("win32", (pid, signal) => signals.push([pid, signal]));
    expect(tree.detached).toBe(false);
    expect(tree.blocked).toMatch(/^BLOCKED\(WI-0025-01\): Windows Job Objects/);
    tree.kill(42);
    tree.stop(42);
    expect(signals).toEqual([
      [42, "SIGKILL"],
      [42, "SIGTERM"],
    ]);
  });

  /**
   * A process table of group members (pid, pgid) that answers signals to a group: `stays` ignore
   * SIGTERM, `outlives` ignore SIGKILL too. Every `ps` run is counted.
   */
  function machine(members: [number, number][], stays: number[] = [], outlives: number[] = []) {
    let table = [...members];
    const signals: [number, string][] = [];
    const reads: string[][] = [];
    const run: CommandRunner = (file, args) => {
      reads.push([file, ...args]);
      return Promise.resolve(
        table.map(([pid, pgid]) => `${String(pid)} ${String(pgid)}\n`).join(""),
      );
    };
    const signal = (target: number, name: string): void => {
      signals.push([target, name]);
      const spared = name === "SIGTERM" ? [...stays, ...outlives] : outlives;
      table = table.filter(([pid, pgid]) => pgid !== -target || spared.includes(pid));
    };
    const pace = { waitMs: 1_000, lookEveryMs: 250, sleep: () => Promise.resolve() };
    return { signals, reads, run, signal, pace };
  }

  it("after its leader exited, asks every descendant politely first, at any depth, and never kills one that went", async () => {
    // The node 42 exited; its child 51 and that one's child 52 are still in its group.
    const m = machine([
      [1, 1],
      [51, 42],
      [52, 42],
      [420, 420],
    ]);
    expect(await processTreeFor("darwin", m.signal, m.run, m.pace).sweep(42)).toEqual([]);
    expect(m.signals).toEqual([[-42, "SIGTERM"]]);
    expect(m.reads[0]).toEqual(["/bin/ps", "-A", "-o", "pid=,pgid="]);
  });

  it("kills one that ignores the polite stop, and names one that outlives the kill", async () => {
    const stubborn = machine([[51, 42]], [51]);
    expect(
      await processTreeFor("darwin", stubborn.signal, stubborn.run, stubborn.pace).sweep(42),
    ).toEqual([]);
    expect(stubborn.signals).toEqual([
      [-42, "SIGTERM"],
      [-42, "SIGKILL"],
    ]);
    const unkillable = machine([[51, 42]], [], [51]);
    expect(
      await processTreeFor("darwin", unkillable.signal, unkillable.run, unkillable.pace).sweep(42),
    ).toEqual([51]);
  });

  it("signals nothing after an exit with nothing left in its group, and never on Windows", async () => {
    // A pid that only starts with its digits is another group's.
    const m = machine([
      [1, 1],
      [4200, 420],
    ]);
    expect(await processTreeFor("linux", m.signal, m.run, m.pace).sweep(42)).toEqual([]);
    expect(m.signals).toEqual([]);
    // Windows: the bare pid of a process that is gone; no table is read, nothing is sent.
    const w = machine([[51, 42]]);
    expect(await processTreeFor("win32", w.signal, w.run, w.pace).sweep(42)).toEqual([]);
    expect([...w.signals, ...w.reads]).toEqual([]);
  });

  it("signals nothing after an exit when the process table cannot be read", async () => {
    const signals: number[] = [];
    const broken: CommandRunner = () => Promise.reject(new Error("ps ended with code 1"));
    const tree = processTreeFor("darwin", (pid) => signals.push(pid), broken);
    await expect(tree.sweep(42)).rejects.toThrow("ps ended with code 1");
    expect(signals).toEqual([]);
  });

  it("treats a tree that is already gone as ended", () => {
    const gone = (): void => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect(() => {
      processTreeFor("linux", gone).kill(42);
    }).not.toThrow();
    expect(() => {
      processTreeFor("win32", gone).kill(42);
    }).not.toThrow();
    expect(() => {
      processTreeFor("linux", gone).stop(42);
      processTreeFor("win32", gone).stop(42);
    }).not.toThrow();
    expect(() => {
      processTreeFor("linux").kill(2 ** 30);
    }).not.toThrow();
  });
});

describe("a node process's exit", () => {
  it("names what its tree left running after a forced kill", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42 });
    const lines: string[] = [];
    let swept: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      swept = resolve;
    });
    watchExit(child as unknown as ChildProcessWithoutNullStreams, {
      graceMs: 0,
      after: () => undefined,
      tree: {
        sweep: () => {
          setImmediate(swept);
          return Promise.resolve([51, 52]);
        },
      },
      log: (line) => lines.push(line),
      exited: () => undefined,
    });
    child.emit("exit", null, "SIGKILL");
    await done;
    expect(lines).toEqual(["still running beneath it after a forced kill: 51, 52"]);
  });
});
