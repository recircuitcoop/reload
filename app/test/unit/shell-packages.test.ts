// The shell's side of the packages (shell/packages.ts; WI-0018-16, -17; plan 0022 §F): the
// restart of only the runtime and its timing, the deployed flows' types, and General's Packages
// board as the shell puts it together (the scheduled update check among it), with a real
// Supervisor over fake children and a fake clock.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsArchiveCache } from "../../src/adapters/fs/catalogue-cache";
import { FsPackageRoots, unsealTree } from "../../src/adapters/fs/package-roots";
import {
  catalogueSource,
  deployedTypes,
  runtimeRestarter,
  wirePackages,
} from "../../src/shell/packages";
import type { PackageSettingsStore } from "../../src/ports/settings-store";
import {
  exitsAtOnce,
  obedient,
  RecordingLogger,
  RecordingNotifier,
  type Behaviour,
} from "../fakes/children";
import { supervised } from "../fakes/supervised";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reload-shell-packages-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** The package settings in memory, as the shell's settings file would hold them. */
export class MemoryPackageSettings implements PackageSettingsStore {
  packages: unknown = undefined;
  sources: unknown = undefined;
  readPackages(): unknown {
    return this.packages;
  }
  writePackages(packages: Readonly<Record<string, unknown>>): void {
    this.packages = { ...packages };
  }
  readSources(): unknown {
    return this.sources;
  }
  writeSources(sources: Readonly<Record<string, unknown>>): void {
    this.sources = { ...sources };
  }
}

/** What a wiring needs beyond WI-0018-16's, for a test that does not look at it. */
const UPDATES_UNUSED = () => ({
  settings: new MemoryPackageSettings(),
  blocked: { reason: () => null, block: () => undefined },
  archives: new FsArchiveCache(path.join(scratch, "updates")),
  notifier: new RecordingNotifier(),
});

/** Answers the first init only: a runtime that never comes back after a restart. */
function comesUpOnce(): Behaviour {
  let inits = 0;
  return {
    onPost(child, message, clock) {
      if (message.t === "init" && ++inits > 1) {
        return;
      }
      obedient.onPost?.(child, message, clock);
    },
  };
}

describe("restarting only the runtime", () => {
  it("resolves with the time from the restart to the next generation running", async () => {
    const { clock, supervisor, logger } = supervised(obedient);
    supervisor.start();
    clock.advance(5);
    const restart = runtimeRestarter(supervisor, clock, logger);
    const took = restart("pinger was installed");
    clock.advance(10);
    expect(await took).toBe(2);
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 2 });
    expect(logger.lines).toContainEqual(
      expect.stringContaining("restarting only the runtime: pinger was installed"),
    );
  });

  it("resolves null at once when the runtime is not running to restart", async () => {
    const { clock, supervisor, logger } = supervised(obedient);
    let ran = 0;
    expect(await runtimeRestarter(supervisor, clock, logger)("x", () => (ran += 1))).toBeNull();
    // Nothing runs to wait for: the work while stopped is done at once.
    expect(ran).toBe(1);
  });

  it("hands the work while stopped to the restart, which runs it between the generations", async () => {
    const { clock, supervisor, logger, launcher } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    const forks: number[] = [];
    const took = runtimeRestarter(
      supervisor,
      clock,
      logger,
    )("x", () => forks.push(launcher.children.length));
    clock.advance(10);
    expect(await took).not.toBeNull();
    expect(forks).toEqual([1]);
  });

  it("never changes anything under a runtime still starting: it restarts it once it runs", async () => {
    const { clock, supervisor, logger, launcher } = supervised(obedient);
    supervisor.start();
    // Forked, not yet ready: a generation that may already read the packages.
    const seen: { oldExited: boolean | undefined; forks: number }[] = [];
    const took = runtimeRestarter(
      supervisor,
      clock,
      logger,
    )("x", () =>
      seen.push({ oldExited: launcher.children[0]?.exited, forks: launcher.children.length }),
    );
    expect(seen).toEqual([]);
    clock.advance(10);
    expect(await took).not.toBeNull();
    expect(seen).toEqual([{ oldExited: true, forks: 1 }]);
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 2 });
  });

  it("does the work at once while no runtime process exists, between crashes or down for good", async () => {
    const { clock, supervisor, logger, launcher } = supervised(exitsAtOnce);
    supervisor.start();
    clock.advance(0);
    // Crashed, waiting out its backoff: no process to see the change.
    expect(launcher.current.exited).toBe(true);
    let ran = 0;
    expect(await runtimeRestarter(supervisor, clock, logger)("x", () => (ran += 1))).toBeNull();
    expect(ran).toBe(1);
    clock.advance(10 * 60_000);
    expect(supervisor.status().state).toBe("down-for-good");
    expect(await runtimeRestarter(supervisor, clock, logger)("y", () => (ran += 1))).toBeNull();
    expect(ran).toBe(2);
  });

  it("resolves null, and says so, when the runtime does not come back", async () => {
    const { clock, supervisor, logger } = supervised(comesUpOnce());
    supervisor.start();
    clock.advance(5);
    const took = runtimeRestarter(supervisor, clock, logger)("x");
    clock.advance(60_000);
    expect(await took).toBeNull();
    expect(logger.lines).toContainEqual(
      expect.stringContaining("the runtime did not come back within 60000 ms"),
    );
  });
});

describe("the deployed flows' types", () => {
  it("are read from Node-RED's saved flows; none before the first deploy", () => {
    const file = path.join(scratch, "flows.json");
    expect(deployedTypes(file)).toEqual([]);
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "t", type: "tab" },
        { id: "a", type: "reload-pinger-ping", z: "t" },
      ]),
    );
    expect(deployedTypes(file)).toEqual(["tab", "reload-pinger-ping"]);
    fs.writeFileSync(file, "{");
    expect(() => deployedTypes(file)).toThrow(SyntaxError);
  });
});

describe("General's Packages board, wired", () => {
  function wired(documents: readonly { name: string; folder: string; document: unknown }[]) {
    const { clock, supervisor } = supervised(obedient);
    const logger = new RecordingLogger();
    const settings = new MemoryPackageSettings();
    const notifier = new RecordingNotifier();
    const board = wirePackages({
      ...UPDATES_UNUSED(),
      notifier,
      settings,
      runtime: supervisor,
      editor: { nodes: () => Promise.resolve(null) },
      clock,
      logger,
      userDir: scratch,
      shippedStore: { documents: () => documents },
      toPage: () => undefined,
      shippedManifestFile: path.join(scratch, "shipped-packages.json"),
      catalogueUrl: "",
      catalogueKey: null,
      catalogueCache: { read: () => null, write: () => undefined, forget: () => undefined },
      http: { get: () => Promise.reject(new Error("no network here")) },
      forgetGenerated: () => undefined,
      environment: {
        roots: new FsPackageRoots(path.join(scratch, "node-packages")),
      } as never,
    });
    return { board, logger, settings, clock, notifier };
  }

  it("puts back, before the runtime reads the packages, a version a crash left aside, and says so", () => {
    // A swap cut between its two renames: nothing live, the old version in previous/.
    const kept = path.join(scratch, "node-packages", "previous", "monty");
    fs.mkdirSync(path.join(kept, "package"), { recursive: true });
    fs.writeFileSync(
      path.join(kept, "installed.json"),
      JSON.stringify({
        package: "monty",
        version: "0.1.0",
        contentHash: "a",
        environment: "node",
        signed: true,
      }),
    );
    const { notifier, logger } = wired([]);
    expect(notifier.notices).toEqual([
      { kind: "package-recovered", subject: "monty", version: "0.1.0" },
    ]);
    expect(
      fs.existsSync(path.join(scratch, "node-packages", "packages", "monty", "installed.json")),
    ).toBe(true);
    expect(logger.lines.join("\n")).toContain("monty had no live version after a cut-short swap");
    unsealTree(path.join(scratch, "node-packages"));
  });

  it("lists the shipped packages, and a build with no catalogue offers none to install", async () => {
    const { board } = wired([
      { name: "anytype", folder: path.join(scratch, "shipped"), document: { version: "1.2.3" } },
    ]);
    const { rows, offers } = await board.board();
    expect(rows.map((row) => [row.package.name, row.package.version, row.package.shipped])).toEqual(
      [["anytype", "1.2.3", true]],
    );
    expect(offers).toEqual([]);
    expect(await board.install("official", "pinger")).toMatchObject({
      ok: false,
      failed: "install",
    });
  });

  it("gives a declaration with no version a question mark", async () => {
    const { board } = wired([{ name: "odd", folder: scratch, document: null }]);
    expect((await board.board()).rows).toMatchObject([{ package: { name: "odd", version: "?" } }]);
  });

  it("checks for updates by itself a minute after the start, then at the settings' interval", async () => {
    const { settings, clock, logger } = wired([]);
    settings.packages = { check_interval: 120 };
    clock.advance(59_999);
    expect(logger.lines.filter((line) => line.includes("update check:"))).toEqual([]);
    clock.advance(1);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(120_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.lines.filter((line) => line.includes("update check: 0 installed"))).toHaveLength(
      2,
    );
  });
});

describe("catalogueSource: only a build that is not installed can be pointed elsewhere", () => {
  const built = {
    catalogueUrl: "https://catalogue.example/official",
    catalogueKey: "the built-in key",
  };
  const env = {
    RELOAD_CATALOGUE_URL: "https://mallory.invalid/catalogue",
    RELOAD_CATALOGUE_KEY: "mallory's key",
  };

  it("an installed build ignores both variables: its own catalogue and key", () => {
    expect(catalogueSource({ packaged: true, env, built })).toEqual(built);
  });

  it("a development or e2e build takes them", () => {
    expect(catalogueSource({ packaged: false, env, built })).toEqual({
      catalogueUrl: "https://mallory.invalid/catalogue",
      catalogueKey: "mallory's key",
    });
  });

  it("with nothing set, a development build uses what it was built with", () => {
    expect(catalogueSource({ packaged: false, env: {}, built })).toEqual(built);
  });
});
