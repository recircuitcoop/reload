// General's Packages board (application/package-board.ts; plan 0022 §F, D5, D6, plan 0013) with
// the real disk adapters: packages installed from folders into a real sealed live root, their
// content re-hashed, kept versions pruned after seven days, and the `packages.unregistered`
// setting in a real settings file. The runtime's restart, its loaded types and its readiness
// are stand-ins; wall-clock time is a number the test moves.
import { FsArchiveCache } from "../../src/adapters/fs/catalogue-cache";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsBlockedUpdates } from "../../src/adapters/fs/blocked-updates";
import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { FsPackageRoots, unsealTree } from "../../src/adapters/fs/package-roots";
import { FsPackageSource } from "../../src/adapters/fs/package-source";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { PackageEnvironmentBuilder } from "../../src/adapters/process/env-builder";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { sha256Hex } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import { OneAtATime, PackageInstaller } from "../../src/application/install-package";
import { NoticeBoard } from "../../src/application/notices";
import {
  PackageBoard,
  type Board,
  type InstallProgress,
} from "../../src/application/package-board";
import type { InstallPhase } from "../../src/application/package-environment";
import { PackageRemover } from "../../src/application/remove-package";
import { shippedManifest, type ShippedManifest } from "../../src/application/shipped-manifest";
import { PackageUpdates } from "../../src/application/update-package";
import { ROLLBACK_WINDOW_MS, rowActions, type Package } from "../../src/domain/packages/states";
import { parsePackagePolicy, unregisteredOf } from "../../src/domain/packages/versions";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";
import { pingPackage, signedArchive } from "../fakes/package-archive";

const DAY = 24 * 60 * 60 * 1000;
const START = 1_760_000_000_000;

let base: string;
let roots: FsPackageRoots;
let settings: JsonSettingsStore;
let logger: RecordingLogger;
let now: number;
let restarts: string[];
/** What the old runtime's node processes do as their stop arrives. */
let stopping: () => void;
/** How long the fake restart took; null: the runtime was not running to restart. */
let took: number | null;
let types: readonly string[] | null;
/** What each package requires, as the shell reads it from the declarations (spec 2.1.6). */
let requiring: { package: string; requires: string[] }[];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-board-")));
  roots = new FsPackageRoots(path.join(base, "node-packages"));
  settings = new JsonSettingsStore(path.join(base, "shell-settings.json"));
  logger = new RecordingLogger();
  now = START;
  published = null;
  offered = "0.1.0";
  pushed = [];
  manifest = {};
  restarts = [];
  stopping = () => undefined;
  took = 100;
  types = [];
  requiring = [];
});

afterEach(() => {
  unsealTree(base);
  fs.rmSync(base, { recursive: true, force: true });
});

/** A package folder at `version`; `body` is its node's code. */
function writeFolder(name: string, version: string, body = "// one\n"): string {
  const folder = path.join(base, "sources", name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [file, data] of Object.entries(pingPackage(name, version, { nodeJs: body }))) {
    fs.writeFileSync(path.join(folder, file), data);
  }
  return folder;
}

const builder = new PackageEnvironmentBuilder({
  locator: {
    uv: () => {
      throw new Error("uv was asked for");
    },
    python: () => {
      throw new Error("python was asked for");
    },
    node: () => {
      throw new Error("node was asked for");
    },
  },
  parentEnvironment: {},
  cacheDir: "unused",
  wheels: { kind: "default" },
  timeoutMs: 1,
  platform: process.platform,
});

/** The official catalogue this test serves: one signed archive, or none. */
let published: { signer: Signer; archive: Uint8Array } | null;

/** How often the official catalogue was asked. */
let asks = 0;

/** The version the official catalogue's entry names (its archive is `published`'s). */
let offered = "0.1.0";

/** Every install phase the board pushed, in order. */
let pushed: InstallProgress[];

/** A shipped package: its folder written as the app would hold it. */
const shippedPackage = (name: string) => ({
  name,
  version: "1.0.0",
  folder: writeFolder(name, "1.0.0"),
});

/** A build shipping `name`, its manifest made: set up with it. */
async function withShipped(name: string) {
  const shipped = shippedPackage(name);
  await build([shipped]);
  return setUp([shipped]);
}

/** This app build's shipped-package manifest, as `npm run build:packages` writes it. */
let manifest: ShippedManifest;

/** Build the app: its manifest hashes the shipped folders as they are now. */
async function build(shipped: readonly { name: string; folder: string }[]): Promise<void> {
  manifest = await shippedManifest(shipped, { source: new FsPackageSource(), sha256: sha256Hex });
}

function setUp(shipped: { name: string; version: string; folder: string }[] = []) {
  let forward: PackageBoard | null = null;
  const environment = {
    source: new FsPackageSource(),
    verifier: new MinisignVerifier(),
    validator: new AjvSchemaValidator(),
    contentHashes: new FsContentHashes(path.join(base, "content-hashes.json")),
    roots,
    builder,
    logger,
    sha256: sha256Hex,
    target: { platform: process.platform, arch: process.arch },
    now: () => now,
    phase: (phase: InstallPhase, name: string | null) => {
      forward?.progress(phase, name);
    },
  };
  // As the supervisor does it: the old runtime stops, the work while stopped runs, then the
  // next one starts.
  const restartRuntime = (reason: string, whileStopped?: () => void) => {
    restarts.push(reason);
    stopping();
    whileStopped?.();
    return Promise.resolve(took);
  };
  const reads = {
    catalogue: () => {
      asks += 1;
      return published === null
        ? Promise.reject(new Error("no catalogue in this build"))
        : Promise.resolve({
            name: "official",
            url: "https://catalogue.test/catalogue.json",
            verified: true,
            fetchedAt: 0,
            entries: [
              {
                packageId: "verkit",
                summary: "Says its version.",
                installSource: "index",
                catalogue: "official",
                verified: true,
                archive: "https://catalogue.test/verkit.tgz",
                version: offered,
              },
            ],
          });
    },
    catalogueKey: published?.signer.publicKeyText ?? null,
    sources: () => [],
    registered: () => Promise.reject(new Error("no registered source")),
    http: {
      get: () =>
        Promise.resolve(
          published === null
            ? { ok: false as const, failure: "status" as const, detail: "404" }
            : { ok: true as const, body: published.archive },
        ),
    },
    saveDownload: (name: string, bytes: Uint8Array) => {
      const file = path.join(base, "downloads", `${name}.tgz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return file;
    },
  };
  const one = new OneAtATime();
  const installer = new PackageInstaller(
    { ...reads, environment, shipped: () => shipped, restartRuntime, logger },
    one,
  );
  const updates = new PackageUpdates(
    {
      ...reads,
      environment,
      archives: new FsArchiveCache(path.join(base, "updates")),
      policy: () => parsePackagePolicy(settings.readPackages()),
      restartRuntime,
      readiness: () => Promise.resolve({ deployed: ["n1"], ready: ["n1"] }),
      blocked: new FsBlockedUpdates(path.join(base, "blocked-updates.json")),
      notifier: new NoticeBoard({ deliver: () => undefined, store: null, logger }),
      clock: new FakeClock(),
      now: () => now,
      logger,
    },
    one,
  );
  const remover = new PackageRemover(
    {
      roots,
      typesInUse: () => Promise.resolve({ deployed: [], undeployed: null }),
      forgetGenerated: () => undefined,
      shipped: () => shipped.map((listed) => listed.name),
      restartRuntime,
      logger,
    },
    one,
  );
  const board = new PackageBoard({
    roots,
    environment,
    shipped: () => shipped,
    installer,
    updates,
    remover,
    settings,
    loadedTypes: () => Promise.resolve(types),
    requiring: () => requiring,
    restartRuntime,
    one,
    shippedManifest: () => manifest,
    onProgress: (progress) => pushed.push(progress),
    now: () => now,
    logger,
  });
  forward = board;
  return { board, installer, updates };
}

const row = (board: Board, name: string): Package => {
  const found = board.rows.find((entry) => entry.package.name === name);
  if (found === undefined) throw new Error(`${name} is not listed`);
  return found.package;
};

describe("from a folder (plan 0013)", () => {
  it("a folder whose code changed under the same version is changed: on Check for changes and at start", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    expect(await board.installFolder(folder)).toEqual({ ok: true });
    expect(await board.checkFolder("monty")).toEqual({ ok: true });
    const fresh = row(await board.board(), "monty");
    expect(fresh).toMatchObject({
      source: { kind: "folder", path: folder },
      signed: false,
      installation: { state: "installed" },
      update: { state: "up-to-date" },
    });

    // New behaviour, the same declared version.
    writeFolder("monty", "0.1.0", "// one\n// a new event kind\n");
    now += 60_000;
    expect(await board.checkFolder("monty")).toEqual({ ok: true });
    const changed = row(await board.board(), "monty");
    expect(changed.update).toEqual({
      state: "changed",
      version: "0.1.0",
      verifiedAt: new Date(now),
    });

    // At start: a new board, as the next launch builds it, says so before anything is pressed.
    const next = setUp().board;
    await next.start();
    expect(row(await next.board(), "monty").update?.state).toBe("changed");
  });

  it("the installed copy is re-hashed: a live file changed fails its check", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    const live = roots.list()[0]?.folder.packageDir ?? "";
    unsealTree(live);
    fs.writeFileSync(path.join(live, "node.js"), "// tampered\n");
    await board.checkFolder("monty");
    expect(row(await board.board(), "monty").installation).toMatchObject({
      state: "failed-check",
      reason: "content-moved",
    });
  });
});

describe("a broken package (plan 0032, group 29)", () => {
  it("is shown with why and a Remove that removes nothing blind, never hidden, and the others as usual", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    await board.installFolder(writeFolder("whodunnit", "0.2.0"));
    unsealTree(roots.live);
    fs.writeFileSync(path.join(roots.live, "monty", "installed.json"), "{ not json");
    const rows = (await board.board()).rows;
    expect(rows.map((each) => each.package.name)).toEqual(["whodunnit", "monty"]);
    const broken = row({ rows, offers: [] }, "monty");
    expect(broken.installation).toMatchObject({
      state: "failed-check",
      broken: expect.stringMatching(/^its record could not be read: /) as string,
    });
    expect(broken.version).toBe("");
    expect(rowActions(broken, new Date(now))).toEqual({ enabled: ["remove"], disabled: [] });
    // Its Remove is wired to the remover, which removes nothing blind: a record nobody can
    // read leaves nothing to walk (tests/test_addons_remove.py), so the row stays, saying why.
    expect(await board.remove("monty", [])).toMatchObject({ ok: false, failed: "remove" });
    expect((await board.board()).rows.map((each) => each.package.name)).toEqual([
      "whodunnit",
      "monty",
    ]);
  });
});

describe("a package this release refuses at load (plan 0032, groups 26 and 29)", () => {
  it("is shown broken at the next start, naming the field, never just left unloaded", async () => {
    const first = setUp();
    await first.board.start();
    await first.board.installFolder(writeFolder("monty", "0.1.0"));
    // As an older release accepted it: a table whose row has no title.
    const live = roots.list()[0]?.folder.packageDir ?? "";
    unsealTree(roots.live);
    const declaration = path.join(live, "reload-package.json");
    const document = JSON.parse(fs.readFileSync(declaration, "utf8")) as {
      types: { config: Record<string, unknown> }[];
    };
    const [type] = document.types;
    if (type === undefined) throw new Error("no type");
    type.config = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          title: "Rows",
          items: { type: "object", properties: { a: { type: "string", title: "A" } } },
        },
      },
    };
    fs.writeFileSync(declaration, JSON.stringify(document));
    const next = setUp();
    await next.board.start();
    const shown = row(await next.board.board(), "monty");
    expect(shown.installation).toMatchObject({
      state: "failed-check",
      reason: "declaration",
      broken: expect.stringContaining("types/0/config/properties/rows/items/title") as string,
    });
    expect(rowActions(shown, new Date(now)).enabled).toContain("remove");
  });
});

describe("shipped packages and install phases", () => {
  it("a shipped package is checked at start against this build's manifest, never against what this machine saw first", async () => {
    const shipped = shippedPackage("reload_anytype");
    await build([shipped]);
    const first = setUp([shipped]).board;
    await first.start();
    expect(row(await first.board(), "reload_anytype").installation).toEqual({
      state: "installed",
      verifiedAt: new Date(now),
    });
    // Changed after the build, before a start had seen it: the first start says it failed.
    fs.appendFileSync(path.join(shipped.folder, "node.js"), "// changed\n");
    now += DAY;
    const tampered = setUp([shipped]).board;
    await tampered.start();
    const failed = row(await tampered.board(), "reload_anytype");
    expect(failed.installation).toEqual({
      state: "failed-check",
      reason: "content-moved",
      verifiedAt: new Date(now),
    });
    // Not offered again from anywhere: reinstalling Reload restores it.
    expect(rowActions(failed, new Date(now))).toEqual({ enabled: [], disabled: ["register"] });
    // An app update ships new content under the same version, with its own manifest: installed.
    await build([shipped]);
    const updated = setUp([shipped]).board;
    await updated.start();
    expect(row(await updated.board(), "reload_anytype").installation?.state).toBe("installed");
    // A build with no manifest passes nothing.
    manifest = {};
    const unbuilt = setUp([shipped]).board;
    await unbuilt.start();
    expect(row(await unbuilt.board(), "reload_anytype").installation?.state).toBe("failed-check");
  });

  it("an install's phases are pushed in order, each with its percentage and when", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    expect(pushed.map(({ name, phase, percent }) => [name, phase, percent])).toEqual([
      [null, "fetching", 0],
      ["monty", "verifying", 25],
      ["monty", "building", 50],
      ["monty", "swapping", 90],
    ]);
    expect(pushed.every((progress) => progress.verifiedAt.getTime() === now)).toBe(true);
  });
});

describe("from the catalogue", () => {
  it("a signed archive's live copy re-hashes to the hash recorded at install", async () => {
    const signer = new Signer();
    const folder = writeFolder("verkit", "0.1.0");
    const files = Object.fromEntries(
      ["reload-package.json", "node.js"].map((file) => [
        file,
        fs.readFileSync(path.join(folder, file), "utf8"),
      ]),
    );
    published = { signer, archive: signedArchive(files, signer) };
    const { board } = setUp();
    await board.start();
    expect(await board.install("official", "verkit")).toEqual({ ok: true });
    const { rows, offers } = await board.board();
    expect(offers).toEqual([]);
    expect(rows.find((entry) => entry.package.name === "verkit")).toMatchObject({
      publisher: "Reload",
      package: {
        signed: true,
        source: { kind: "catalogue" },
        installation: { state: "installed" },
      },
    });
  });
});

describe("update and Go back (D5)", () => {
  it("a newer folder version is updated, and Go back within seven days returns it and offers the left version again", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.checkFolder("monty");
    expect(row(await board.board(), "monty").update).toMatchObject({
      state: "available",
      version: "0.2.0",
    });
    restarts = [];
    expect(await board.update("monty")).toEqual({ ok: true });
    expect(row(await board.board(), "monty")).toMatchObject({
      version: "0.2.0",
      update: {
        state: "updated",
        version: "0.2.0",
        previous: "0.1.0",
        rollbackUntil: new Date(now + ROLLBACK_WINDOW_MS),
      },
    });

    now += 6 * DAY;
    expect(await board.goBack("monty")).toEqual({ ok: true });
    expect(restarts.at(-1)).toBe("monty went back to 0.1.0");
    const back = row(await board.board(), "monty");
    // Never blocked: the version it left is offered again, and can be applied again.
    expect(back).toMatchObject({
      version: "0.1.0",
      update: { state: "available", version: "0.2.0" },
    });
    expect(fs.existsSync(path.join(base, "blocked-updates.json"))).toBe(false);
    // Kept in the record put back: a restart still offers it, with its folder gone quiet.
    expect(roots.installed("monty")?.left).toEqual({ version: "0.2.0", at: now });
    fs.rmSync(folder, { recursive: true });
    const next = setUp().board;
    await next.start();
    expect(row(await next.board(), "monty").update).toEqual({
      state: "available",
      version: "0.2.0",
      verifiedAt: new Date(now),
    });
    writeFolder("monty", "0.2.0");
    expect(await next.update("monty")).toEqual({ ok: true });
    expect(row(await next.board(), "monty").version).toBe("0.2.0");
    expect(roots.installed("monty")?.left).toBeUndefined();
  });

  it("a 0.2.x record has no install time: its kept copy survives the first start, and is pruned seven days after it", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.update("monty");
    // As 0.2.1 wrote it: no installedAt.
    const live = path.join(base, "node-packages", "packages", "monty");
    unsealTree(live);
    const record = path.join(live, "installed.json");
    const old = JSON.parse(fs.readFileSync(record, "utf8")) as Record<string, unknown>;
    delete old["installedAt"];
    fs.writeFileSync(record, JSON.stringify(old));

    now += 30 * DAY;
    const first = setUp().board;
    await first.start();
    expect(roots.kept("monty")?.version).toBe("0.1.0");
    expect(roots.installed("monty")?.installedAt).toBe(now);
    // Go back is offered, and the row does not call this start the update's day.
    expect(row(await first.board(), "monty").update).toMatchObject({
      state: "updated",
      previous: "0.1.0",
      at: null,
    });
    now += 6 * DAY;
    await setUp().board.start();
    expect(roots.kept("monty")?.version).toBe("0.1.0");
    now += DAY;
    await setUp().board.start();
    expect(roots.kept("monty")).toBeUndefined();
  });

  it("Go back swaps the version it leaves out only once its instances have stopped", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.checkFolder("monty");
    expect(await board.update("monty")).toEqual({ ok: true });
    const atStop: (string | undefined)[] = [];
    stopping = () => atStop.push(roots.installed("monty")?.version);
    expect(await board.goBack("monty")).toEqual({ ok: true });
    // The 0.2.0 instances closed on 0.2.0's files; 0.1.0 was live for the next start.
    expect(atStop).toEqual(["0.2.0"]);
    expect(roots.installed("monty")?.version).toBe("0.1.0");
  });

  it("Go back with the runtime down is done once the version is back on disk", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.checkFolder("monty");
    expect(await board.update("monty")).toEqual({ ok: true });
    took = null;
    expect(await board.goBack("monty")).toEqual({ ok: true });
    expect(roots.installed("monty")?.version).toBe("0.1.0");
  });

  it("Go back that cannot record the version it left is still back, and says so", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.checkFolder("monty");
    expect(await board.update("monty")).toEqual({ ok: true });
    // The kept 0.1.0 becomes live; its record's amendment cannot be written.
    const kept = path.join(roots.previous, "monty");
    unsealTree(kept);
    fs.mkdirSync(path.join(kept, "installed.json.tmp"));
    fs.writeFileSync(path.join(kept, "installed.json.tmp", "x"), "");
    expect(await board.goBack("monty")).toEqual({ ok: true });
    expect(roots.installed("monty")?.version).toBe("0.1.0");
    expect(logger.lines.join("\n")).toContain("monty went back; 0.2.0 is not offered again");
  });

  it("after seven days Go back is refused, and the next start prunes what was kept", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.update("monty");
    expect(roots.kept("monty")?.version).toBe("0.1.0");

    now += 7 * DAY;
    expect(row(await board.board(), "monty").update?.state).not.toBe("updated");
    expect(await board.goBack("monty")).toEqual({
      ok: false,
      refusal: { reason: "rollback-expired" },
    });
    await setUp().board.start();
    expect(roots.kept("monty")).toBeUndefined();
    expect(logger.lines.some((line) => line.includes("past its seven days: pruned"))).toBe(true);
  });
});

describe("register and unregister (D6)", () => {
  it("unregister is refused while used, naming every use, and otherwise stored, and only the runtime restarts", async () => {
    const { board } = await withShipped("reload_anytype");
    await board.start();
    types = ["reload-reload_anytype-create", "inject"];
    const uses = [
      { flow: "Recordings to Anytype", step: "File" },
      { flow: "Invoices from the mailbox", step: "File invoice" },
    ];
    expect(await board.unregister("reload_anytype", uses)).toEqual({
      ok: false,
      refusal: { reason: "in-use", action: "unregister", uses },
    });
    expect(row(await board.board(), "reload_anytype").registration?.state).toBe("registered");

    expect(await board.unregister("reload_anytype", [])).toEqual({ ok: true });
    expect(unregisteredOf(settings.readPackages())).toEqual(["reload_anytype"]);
    expect(restarts).toEqual(["reload_anytype was unregistered"]);
    types = ["inject"];
    expect(row(await board.board(), "reload_anytype").registration).toEqual({
      state: "not-registered",
      verifiedAt: new Date(now),
    });
    // A shipped package is unregistered, never removed.
    expect(await board.remove("reload_anytype", [])).toEqual({
      ok: false,
      refusal: { reason: "shipped" },
    });

    expect(await board.register("reload_anytype")).toEqual({ ok: true });
    expect(unregisteredOf(settings.readPackages())).toEqual([]);
  });

  it("remove takes the name out of the unregistered list", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    types = ["reload-monty-ping"];
    expect(await board.unregister("monty", [])).toEqual({ ok: true });
    expect(unregisteredOf(settings.readPackages())).toEqual(["monty"]);
    expect(await board.remove("monty", [])).toEqual({ ok: true });
    expect(unregisteredOf(settings.readPackages())).toEqual([]);
  });

  it("no state without when it was checked; registration unverified while the runtime is not running", async () => {
    const { board } = await withShipped("reload_anytype");
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    types = null;
    const listed = await board.board();
    for (const { package: pkg } of listed.rows) {
      expect(pkg.registration).toBeNull();
      for (const facet of [pkg.installation, pkg.update]) {
        if (facet !== null) expect(facet.verifiedAt).toBeInstanceOf(Date);
      }
    }
  });
});

describe("the start asks only when the settings let it (D14)", () => {
  it("with auto_check_versions off, no source is asked at start", async () => {
    const signer = new Signer();
    const folder = writeFolder("verkit", "0.1.0");
    const files = Object.fromEntries(
      ["reload-package.json", "node.js"].map((file) => [
        file,
        fs.readFileSync(path.join(folder, file), "utf8"),
      ]),
    );
    published = { signer, archive: signedArchive(files, signer) };
    const { board } = setUp();
    await board.start();
    expect(await board.install("official", "verkit")).toEqual({ ok: true });
    settings.writePackages({ auto_check_versions: false });
    asks = 0;
    const next = setUp().board;
    await next.start();
    expect(asks).toBe(0);
    // Its update is then unverified, and the row shows none.
    expect(row(await next.board(), "verkit").update).toBeNull();
  });
});

describe("a package that failed its check", () => {
  it("is removed or installed again from where it came from", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    const live = roots.list()[0]?.folder.packageDir ?? "";
    unsealTree(live);
    fs.writeFileSync(path.join(live, "node.js"), "// tampered\n");
    await board.checkFolder("monty");
    const failed = row(await board.board(), "monty");
    expect(failed.installation?.state).toBe("failed-check");
    expect(rowActions(failed, new Date(now)).enabled).toEqual(
      expect.arrayContaining(["remove", "install"]),
    );
    now += 60_000;
    expect(await board.reinstall("monty")).toEqual({ ok: true });
    expect(row(await board.board(), "monty").installation).toEqual({
      state: "installed",
      verifiedAt: new Date(now),
    });
    // The copy that failed is not kept as one to go back to.
    expect(roots.kept("monty")).toBeUndefined();
    expect(await board.reinstall("monty")).toEqual({
      ok: false,
      refusal: { reason: "nothing-to-do" },
    });
  });

  it("a folder that cannot be read is said, and Check for changes waits until it can", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board, updates } = setUp();
    await board.start();
    await board.installFolder(folder);
    fs.rmSync(folder, { recursive: true });
    await board.checkFolder("monty");
    const pkg = row(await board.board(), "monty");
    expect(pkg.source).toEqual({ kind: "folder", path: folder, unreadable: true });
    expect(rowActions(pkg, new Date(now)).disabled).toContain("check-for-changes");
    // Back: the next scheduled check, in this session, finds it readable again.
    writeFolder("monty", "0.1.0");
    now += 60_000;
    expect(await updates.check()).toMatchObject({ ok: true });
    const checked = row(await board.board(), "monty");
    expect(checked.source).toEqual({ kind: "folder", path: folder });
    expect(rowActions(checked, new Date(now)).enabled).toContain("check-for-changes");
    // And the next start asks it again too.
    const next = setUp().board;
    await next.start();
    const back = row(await next.board(), "monty");
    expect(back.source).toEqual({ kind: "folder", path: folder });
    expect(rowActions(back, new Date(now)).enabled).toContain("check-for-changes");
  });
});

describe("Install again repairs the version installed, in place", () => {
  it("within seven days of an update, the version before is still kept and Go back keeps its deadline", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.checkFolder("monty");
    expect(await board.update("monty")).toEqual({ ok: true });
    expect(roots.kept("monty")?.version).toBe("0.1.0");
    const before = row(await board.board(), "monty").update;
    expect(before?.state).toBe("updated");
    // The live 0.2.0 copy fails its check.
    const live = roots.list()[0]?.folder.packageDir ?? "";
    unsealTree(live);
    fs.writeFileSync(path.join(live, "node.js"), "// tampered\n");
    await board.checkFolder("monty");
    expect(row(await board.board(), "monty").installation?.state).toBe("failed-check");
    now += DAY;
    expect(await board.reinstall("monty")).toEqual({ ok: true });
    const after = row(await board.board(), "monty");
    expect(after.version).toBe("0.2.0");
    expect(after.installation?.state).toBe("installed");
    expect(roots.kept("monty")?.version).toBe("0.1.0");
    // The same update, the same deadline: Go back still offered, and still works.
    expect(after.update).toEqual(before);
    expect(rowActions(after, new Date(now)).enabled).toContain("go-back");
    expect(await board.goBack("monty")).toEqual({ ok: true });
    expect(roots.installed("monty")?.version).toBe("0.1.0");
  });

  it("a folder that no longer holds that version changes nothing", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    const live = roots.list()[0]?.folder.packageDir ?? "";
    unsealTree(live);
    fs.writeFileSync(path.join(live, "node.js"), "// tampered\n");
    await board.checkFolder("monty");
    writeFolder("monty", "0.3.0");
    expect(await board.reinstall("monty")).toEqual({ ok: false, failed: "install" });
    expect(roots.installed("monty")?.version).toBe("0.1.0");
    expect(row(await board.board(), "monty").installation?.state).toBe("failed-check");
  });

  it("a catalogue package is installed again at its recorded version, verified, or not at all", async () => {
    const signer = new Signer();
    const folder = writeFolder("verkit", "0.1.0");
    const files = Object.fromEntries(
      ["reload-package.json", "node.js"].map((file) => [
        file,
        fs.readFileSync(path.join(folder, file), "utf8"),
      ]),
    );
    const archive010 = signedArchive(files, signer);
    published = { signer, archive: archive010 };
    const { board } = setUp();
    await board.start();
    expect(await board.install("official", "verkit")).toEqual({ ok: true });
    const live = roots.list()[0]?.folder.packageDir ?? "";
    unsealTree(live);
    fs.writeFileSync(path.join(live, "node.js"), "// tampered\n");
    const tampered = setUp().board;
    await tampered.start();
    expect(row(await tampered.board(), "verkit").installation?.state).toBe("failed-check");

    // The catalogue has moved on: 0.1.0 is no longer obtainable, and nothing changes.
    offered = "0.2.0";
    expect(await tampered.reinstall("verkit")).toEqual({ ok: false, failed: "install" });
    expect(roots.installed("verkit")?.version).toBe("0.1.0");
    expect(row(await tampered.board(), "verkit").installation?.state).toBe("failed-check");
    expect(logger.lines.some((line) => line.includes("verkit 0.1.0 is no longer offered"))).toBe(
      true,
    );

    // Offered again: installed again, verified as at install.
    offered = "0.1.0";
    expect(await tampered.reinstall("verkit")).toEqual({ ok: true });
    expect(row(await tampered.board(), "verkit").installation?.state).toBe("installed");
    expect(roots.installed("verkit")).toMatchObject({ version: "0.1.0", signed: true });
  });
});

describe("per-package update controls: a mode from the page, Off, and Update all", () => {
  const modeOf = (board: Board, name: string) =>
    board.rows.find((entry) => entry.package.name === name)?.mode;

  it("a mode set from the page round-trips, and leaves every other setting alone", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    const file = path.join(base, "shell-settings.json");
    const others = {
      telemetry: true,
      update: { auto_check: false },
      packages: {
        update_mode: "manual",
        check_interval: 3600,
        unregistered: ["reload_anytype"],
        overrides: { whodunnit: { update_mode: "pinned" } },
      },
    };
    fs.writeFileSync(file, JSON.stringify(others));
    expect(modeOf(await board.board(), "monty")).toBe("manual");

    expect(board.setMode("monty", "pinned")).toEqual({ ok: true });
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({ telemetry: true, update: { auto_check: false } });
    expect(written["packages"]).toEqual({
      ...others.packages,
      overrides: { whodunnit: { update_mode: "pinned" }, monty: { update_mode: "pinned" } },
    });
    expect(modeOf(await board.board(), "monty")).toBe("pinned");

    // Unpinned: its own mode is gone, and the default decides again.
    expect(board.setMode("monty", null)).toEqual({ ok: true });
    expect(settings.readPackages()).toEqual(others.packages);
    expect(modeOf(await board.board(), "monty")).toBe("manual");
    expect(board.setMode("monty", "off")).toEqual({ ok: true });
    expect(modeOf(await board.board(), "monty")).toBe("off");
  });

  it("refuses a name that is not an installed package, and writes nothing", async () => {
    const { board } = setUp();
    await board.start();
    const file = path.join(base, "shell-settings.json");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    expect(board.setMode("Who.Dunnit", "pinned")).toEqual({
      ok: false,
      refusal: { reason: "not-installed" },
    });
    expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null).toBe(before);
  });

  it("Update all applies every package that is not pinned or off, one after another", async () => {
    const { board } = setUp();
    await board.start();
    for (const name of ["monty", "whodunnit", "pinned_one", "off_one"]) {
      await board.installFolder(writeFolder(name, "1.0.0"));
      writeFolder(name, "2.0.0");
    }
    expect(board.setMode("pinned_one", "pinned")).toEqual({ ok: true });
    expect(board.setMode("off_one", "off")).toEqual({ ok: true });
    restarts = [];
    expect(await board.updateAll()).toEqual({ ok: true });
    expect(roots.installed("monty")?.version).toBe("2.0.0");
    expect(roots.installed("whodunnit")?.version).toBe("2.0.0");
    expect(roots.installed("pinned_one")?.version).toBe("1.0.0");
    expect(roots.installed("off_one")?.version).toBe("1.0.0");
    expect(restarts).toEqual(["monty was updated to 2.0.0", "whodunnit was updated to 2.0.0"]);
    // Nothing newer: Update all is done, and changes nothing.
    expect(await board.updateAll()).toEqual({ ok: true });
    expect(restarts).toHaveLength(2);
  });
});

// A package that requires another (spec 2.1.6; the old resolver's `requires`,
// test_addons_remove.py, test_plugin_page.py, test_enable_switch.py).
describe("a package another one requires", () => {
  it("is refused for removal and unregistering by name, nothing removed nor restarted, and drawn not removable", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    await board.installFolder(writeFolder("whodunnit", "0.1.0"));
    types = ["reload-monty-ping", "reload-whodunnit-ping"];
    requiring = [
      { package: "monty", requires: [] },
      { package: "whodunnit", requires: ["monty"] },
    ];
    restarts.length = 0;

    const refusal = { reason: "required", by: "whodunnit requires monty" };
    expect(await board.remove("monty", [])).toEqual({ ok: false, refusal });
    expect(await board.unregister("monty", [])).toEqual({ ok: false, refusal });
    expect(restarts).toEqual([]);
    const listed = await board.board();
    expect(row(listed, "monty").installation?.state).toBe("installed");
    expect(row(listed, "monty").requiredBy).toBe("whodunnit requires monty");
    // Asked before the control is drawn: monty's Remove and Unregister are shown disabled.
    expect(rowActions(row(listed, "monty"), new Date(now)).disabled).toEqual([
      "unregister",
      "remove",
    ]);
    expect(rowActions(row(listed, "whodunnit"), new Date(now)).enabled).toContain("remove");

    // Once what requires it is off, it goes.
    expect(await board.unregister("whodunnit", [])).toEqual({ ok: true });
    expect(await board.remove("monty", [])).toEqual({ ok: true });
  });

  it("says why one is held back, in the runtime's words, and holds back nothing it requires", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("beta", "0.1.0"));
    await board.installFolder(writeFolder("delta", "0.1.0"));
    requiring = [
      { package: "beta", requires: [] },
      { package: "delta", requires: ["beta"] },
    ];
    types = ["reload-beta-ping", "reload-delta-ping"];
    expect(row(await board.board(), "delta").heldBack).toBeUndefined();

    // Off by hand: Reload itself refuses to turn off what delta requires.
    expect(await board.unregister("beta", [])).toMatchObject({ ok: false });
    settings.writePackages({ ...(settings.readPackages() as object), unregistered: ["beta"] });
    types = [];
    const listed = await board.board();
    expect(row(listed, "delta").heldBack).toBe("requires beta, which is off");
    expect(row(listed, "beta").heldBack).toBeUndefined();
  });
});
