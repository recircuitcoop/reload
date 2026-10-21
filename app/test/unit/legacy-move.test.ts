// The first start of Reload over an InnyTypes 0.3.0 installation (plan 0028 step 1): the userData
// rename whichever case the old directory has on disk and whatever Electron made beforehand, the
// refusal while 0.3.0 still runs (with nothing moved, not even the secrets), the two-folders case,
// each step recorded and finished after an interrupted start, and the credential replacement
// offered on the move's own start only.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonLegacyImportReportStore } from "../../src/adapters/fs/legacy-import-report";
import {
  dropInstallRecord,
  firstStartIn,
  firstStartMove,
  holdsAppData,
  LEGACY_USER_DATA_NAME,
  legacyCredentialsDirectory,
  moveLegacySecrets,
  relocatedAfterMove,
  renamedNodeType,
  rewriteLegacyNodeTypes,
  setAsideFlowCredentials,
  type FirstStartOptions,
} from "../../src/adapters/fs/legacy-move";

let scratch: string;
let appData: string;
let legacy: string;
let userData: string;
let journalRewrites: string[];

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-move-")));
  appData = path.join(scratch, "app-data");
  legacy = path.join(appData, LEGACY_USER_DATA_NAME);
  userData = path.join(appData, "Reload");
  journalRewrites = [];
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const mode = (file: string) => fs.statSync(file).mode & 0o777;
const oldSecrets = () => path.join(scratch, ".config", "innytypes");
const newSecrets = () => path.join(scratch, ".config", "reload");

/** A 0.3.0 userData directory with flows, settings and its import report. */
function fixture03(where = legacy): void {
  write(
    path.join(where, "node-red", "flows.json"),
    JSON.stringify([
      { id: "t", type: "tab" },
      { id: "w", type: "inny-folder-watch", z: "t", folder: "/x" },
    ]),
  );
  write(
    path.join(where, "shell-settings.json"),
    JSON.stringify({ telemetry: false, appUpdate: { lastVersion: "0.3.0", previous: null } }),
  );
  write(
    path.join(where, "legacy-import-report.json"),
    JSON.stringify({
      importedAt: "2026-10-15T00:00:00Z",
      launchAtLoginWanted: false,
      imported: [],
      ignored: [],
    }),
  );
  write(path.join(where, "node-red", "generated", "inny-folder-watch.js"), "");
  write(path.join(oldSecrets(), "anytype_api_key"), "key");
}

const options = (over: Partial<FirstStartOptions> = {}): FirstStartOptions => ({
  legacyUserData: legacy,
  userData,
  secrets: { platform: "linux", home: scratch, env: {} },
  rewriteJournal: (file) => {
    journalRewrites.push(file);
    return 0;
  },
  ...over,
});

/** Whether this scratch's file system ignores case (macOS and Windows by default). */
function caseInsensitive(): boolean {
  fs.writeFileSync(path.join(scratch, "probe"), "");
  return fs.existsSync(path.join(scratch, "PROBE"));
}

describe("the userData move", () => {
  it("renames 0.3.0's userData, moves the secrets, renames the node types and records every step", () => {
    fixture03();
    const outcome = firstStartMove(options());

    expect(outcome.problem).toBeNull();
    expect(outcome.failed).toEqual([]);
    expect(outcome.movedUserData).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(userData, "node-red", "flows.json"), "utf8")).toContain(
      "reload-reload_folder-watch",
    );
    expect(fs.existsSync(path.join(userData, "node-red", "generated"))).toBe(false);
    expect(fs.readFileSync(path.join(newSecrets(), "anytype_api_key"), "utf8")).toBe("key");
    expect(journalRewrites).toEqual([path.join(userData, "journal.sqlite")]);
    const store = new JsonLegacyImportReportStore(userData);
    expect(store.readMove()?.steps).toEqual({
      userData: "done",
      secrets: "done",
      settings: "done",
      flows: "done",
      journal: "done",
      credentials: "pending",
    });
    // The import's own report came along, untouched: it never runs again.
    expect(store.exists()).toBe(true);
  });

  it("moves over the empty folder Electron makes before the main script runs (the default path)", () => {
    fixture03();
    fs.mkdirSync(userData, { recursive: true }); // as Electron leaves it, measured on Electron 44
    fs.mkdirSync(path.join(userData, "GPUPersistentCache"));

    expect(holdsAppData(userData)).toBe(false);
    const outcome = firstStartMove(options());

    expect(outcome.movedUserData).toBe(true);
    expect(fs.existsSync(path.join(userData, "shell-settings.json"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("finds the old directory whatever its case on disk where the file system ignores case", () => {
    const onDisk = path.join(appData, "innytypes");
    fixture03(onDisk);
    const outcome = firstStartMove(options());
    if (caseInsensitive()) {
      expect(outcome.movedUserData).toBe(true);
      expect(fs.existsSync(path.join(userData, "shell-settings.json"))).toBe(true);
    } else {
      // A case-sensitive system's `innytypes` is the Python app's, never 0.3.0's userData.
      expect(outcome.movedUserData).toBe(false);
      expect(fs.existsSync(onDisk)).toBe(true);
    }
  });

  it("refuses while InnyTypes runs, and moves nothing at all, not even the secrets", () => {
    fixture03();
    fs.symlinkSync(`somehost-${String(process.pid)}`, path.join(legacy, "SingletonLock"));

    const outcome = firstStartMove(options());

    expect(outcome.problem).toContain("InnyTypes is still running");
    expect(fs.existsSync(path.join(legacy, "shell-settings.json"))).toBe(true);
    expect(holdsAppData(userData)).toBe(false);
    expect(fs.existsSync(path.join(oldSecrets(), "anytype_api_key"))).toBe(true);
    expect(fs.existsSync(path.join(newSecrets(), "anytype_api_key"))).toBe(false);
  });

  it("moves past a lock left by an InnyTypes that is no longer running", () => {
    fixture03();
    fs.symlinkSync("somehost-2147483646", path.join(legacy, "SingletonLock"));
    expect(firstStartMove(options()).movedUserData).toBe(true);
  });

  it("leaves 0.3.0's data where it is when Reload already holds its own, says so once, merges nothing", () => {
    fixture03();
    write(path.join(userData, "settings.json"), '{"mcp":{"port":32000}}');

    const first = firstStartMove(options());
    expect(first.problem).toBeNull();
    expect(first.movedUserData).toBe(false);
    expect(first.leftAlone).toContain("was left where it was");
    expect(fs.existsSync(path.join(legacy, "shell-settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(userData, "shell-settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(oldSecrets(), "anytype_api_key"))).toBe(true);
    // Said once.
    expect(firstStartMove(options()).leftAlone).toBeNull();
  });

  it("never moves the secrets on a later start", () => {
    fixture03();
    firstStartMove(options());
    write(path.join(oldSecrets(), "mcp_proxy_token"), "late");
    firstStartMove(options());
    expect(fs.existsSync(path.join(oldSecrets(), "mcp_proxy_token"))).toBe(true);
    expect(fs.existsSync(path.join(newSecrets(), "mcp_proxy_token"))).toBe(false);
  });

  it("drops 0.3.0's install record, so Reload never offers to go back to 0.3.0", () => {
    fixture03();
    firstStartMove(options());
    const settings = JSON.parse(
      fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings).toEqual({ telemetry: false });
  });
});

describe("an interrupted move is finished at the next start", () => {
  it("finishes the steps recorded as not done", () => {
    fixture03();
    // A crash right after the rename: the record moved with the data, every step still pending.
    new JsonLegacyImportReportStore(legacy).writeMove({
      from: legacy,
      steps: {
        userData: "pending",
        secrets: "pending",
        settings: "pending",
        flows: "pending",
        journal: "pending",
        credentials: "pending",
      },
    });
    fs.renameSync(legacy, userData);

    const outcome = firstStartMove(options());

    expect(outcome.failed).toEqual([]);
    expect(new JsonLegacyImportReportStore(userData).readMove()?.steps.flows).toBe("done");
    expect(fs.readFileSync(path.join(userData, "node-red", "flows.json"), "utf8")).toContain(
      "reload-reload_folder-watch",
    );
    expect(journalRewrites).toHaveLength(1);
  });

  it("says a flows.json it cannot read, records the step as failed and tries it again", () => {
    fixture03();
    write(path.join(legacy, "node-red", "flows.json"), "{ not json");

    const first = firstStartMove(options());
    expect(first.problem).toBeNull();
    expect(first.failed).toEqual([expect.stringMatching(/^flows: .*flows\.json is not JSON/)]);
    expect(new JsonLegacyImportReportStore(userData).readMove()?.steps.flows).toMatch(/^failed: /);

    write(
      path.join(userData, "node-red", "flows.json"),
      JSON.stringify([{ id: "w", type: "inny-folder-watch" }]),
    );
    const second = firstStartMove(options());
    expect(second.failed).toEqual([]);
    expect(new JsonLegacyImportReportStore(userData).readMove()?.steps.flows).toBe("done");
  });
});

describe("the credential secret", () => {
  it("may be replaced on the move's own start only", () => {
    fixture03();
    const moved = firstStartMove(options());
    const replace = moved.credentialReplacement(() => undefined);
    expect(replace).not.toBeNull();
    replace?.done();
    expect(firstStartMove(options()).credentialReplacement(() => undefined)).toBeNull();
  });

  it("is never replaceable without a move", () => {
    expect(
      firstStartMove(options({ secrets: null })).credentialReplacement(() => undefined),
    ).toBeNull();
  });

  it("sets the old credentials aside under a new name each time, never overwriting one", () => {
    const folder = path.join(scratch, "node-red");
    expect(setAsideFlowCredentials(scratch)).toBeNull();
    const now = new Date("2026-10-20T10:00:00Z");
    write(path.join(folder, "flows_cred.json"), "first");
    const first = setAsideFlowCredentials(scratch, now);
    write(path.join(folder, "flows_cred.json"), "second");
    const second = setAsideFlowCredentials(scratch, now);
    expect(first).not.toBe(second);
    expect(fs.readFileSync(String(first), "utf8")).toBe("first");
    expect(fs.readFileSync(String(second), "utf8")).toBe("second");
  });
});

describe("helpers", () => {
  it("renames every generated type, the renamed packages under their new names", () => {
    expect(renamedNodeType("inny-anytype-create-object")).toBe(
      "reload-reload_anytype-create-object",
    );
    expect(renamedNodeType("inny-user-events-note-v1")).toBe("reload-user-events-note-v1");
    expect(renamedNodeType("inject")).toBe("inject");
  });

  it("leaves a flows file with nothing to rename byte for byte", () => {
    const flows = path.join(scratch, "flows.json");
    write(flows, '[{"id":"t","type":"tab"}]');
    expect(rewriteLegacyNodeTypes(flows)).toBe(0);
    expect(fs.readFileSync(flows, "utf8")).toBe('[{"id":"t","type":"tab"}]');
    expect(rewriteLegacyNodeTypes(path.join(scratch, "missing.json"))).toBe(0);
  });

  it("moves the secrets at 0600 in 0700, the key from the oldest place when that is all there is", () => {
    write(
      path.join(scratch, "Library", "Application Support", "innytypes", "anytype_api_key"),
      "old",
    );
    write(path.join(oldSecrets(), "mcp-headers.sh"), "#!/bin/sh\n");
    moveLegacySecrets({ platform: "darwin", home: scratch, env: {} });
    expect(fs.readFileSync(path.join(newSecrets(), "anytype_api_key"), "utf8")).toBe("old");
    expect(mode(newSecrets())).toBe(0o700);
    expect(mode(path.join(newSecrets(), "anytype_api_key"))).toBe(0o600);
    expect(fs.existsSync(path.join(oldSecrets(), "mcp-headers.sh"))).toBe(true);
  });

  it("follows a path of the old Python app into the moved directory", () => {
    fs.mkdirSync(userData, { recursive: true });
    write(path.join(userData, "config.toml"), "");
    const lower = path.join(appData, "innytypes", "config.toml");
    expect(relocatedAfterMove(lower, legacy, userData, "darwin")).toBe(
      path.join(userData, "config.toml"),
    );
    expect(relocatedAfterMove(lower, legacy, userData, "linux")).toBe(lower);
  });
});

describe("what the move does when something is not as expected", () => {
  it("moves past a lock that names no process", () => {
    fixture03();
    fs.symlinkSync("not-a-pid", path.join(legacy, "SingletonLock"));
    expect(firstStartMove(options()).movedUserData).toBe(true);
  });

  it("says a userData it could not move, and the start does not go on", () => {
    fixture03();
    // Into a directory inside itself: the rename is refused.
    const outcome = firstStartMove(options({ userData: path.join(legacy, "Reload") }));
    expect(outcome.problem).toMatch(/could not be moved to .*: EINVAL$/);
    expect(outcome.movedUserData).toBe(false);
  });

  it("says a move record it cannot write, and the start does not go on", () => {
    fixture03();
    write(path.join(userData, "settings.json"), "{}");
    write(path.join(userData, "legacy-import-report.json", "in-the-way"), "");
    expect(firstStartMove(options()).problem).toMatch(
      /^the move from InnyTypes could not be recorded: /,
    );
  });

  it("moves the old app's secrets once on a first install with no 0.3.0 before it", () => {
    write(path.join(oldSecrets(), "mcp_proxy_token"), "token");
    const outcome = firstStartMove(options({ legacyUserData: null }));
    expect(outcome.moved).toEqual([expect.stringMatching(/^mcp_proxy_token: /)]);
    expect(outcome.movedUserData).toBe(false);
    expect(fs.readFileSync(path.join(newSecrets(), "mcp_proxy_token"), "utf8")).toBe("token");
    // With no legacy directory, a path is never relocated.
    expect(outcome.relocate("/a/b")).toBe("/a/b");
  });

  it("moves no secrets when told not to, and counts the journal rows renamed", () => {
    fixture03();
    write(path.join(legacy, "shell-settings.json"), "{}");
    write(path.join(legacy, "node-red", "flows.json"), "[]");
    const outcome = firstStartMove(options({ secrets: null, rewriteJournal: () => 2 }));
    expect(outcome.moved).toEqual([`userData: ${legacy} -> ${userData}`, "2 journal rows renamed"]);
    expect(fs.existsSync(path.join(oldSecrets(), "anytype_api_key"))).toBe(true);
    // A path of the old directory is followed into the moved one; the credentials set aside.
    expect(outcome.relocate(path.join(legacy, "config.toml"))).toBe(
      path.join(userData, "config.toml"),
    );
    write(path.join(userData, "node-red", "flows_cred.json"), "{}");
    expect(outcome.credentialReplacement(() => undefined)?.setAside()).toMatch(
      /flows_cred\.unreadable-.*\.json$/,
    );
  });

  it("refuses a flows file that is not a list, and skips nodes with no type", () => {
    const flows = path.join(scratch, "flows.json");
    write(flows, "{}");
    expect(() => rewriteLegacyNodeTypes(flows)).toThrow("does not hold a list of nodes");
    write(flows, JSON.stringify([null, 1, { id: "x" }, { id: "w", type: "inny-folder-watch" }]));
    expect(rewriteLegacyNodeTypes(flows)).toBe(1);
  });

  it("drops no install record when there is no settings file, or none in it", () => {
    expect(dropInstallRecord(scratch)).toBe(false);
    write(path.join(scratch, "shell-settings.json"), "{}");
    expect(dropInstallRecord(scratch)).toBe(false);
  });

  it("spells the old secret directory and the moved files the Windows way on Windows", () => {
    expect(legacyCredentialsDirectory("C:\\Users\\a", "win32")).toBe(
      "C:\\Users\\a\\.config\\innytypes",
    );
    expect(moveLegacySecrets({ platform: "win32", home: "C:\\Users\\a", env: {} })).toEqual([]);
  });
});

describe("firstStartIn", () => {
  const app = (isPackaged: boolean) => ({
    isPackaged,
    getPath: (name: "appData" | "userData") => (name === "appData" ? appData : userData),
  });

  function start(isPackaged: boolean, e2eHooks: boolean): { outcome: unknown; errors: string[] } {
    const errors: string[] = [];
    const outcome = firstStartIn(
      app(isPackaged),
      e2eHooks,
      { RELOAD_TEST_APP_DATA: appData },
      () => 0,
      { showErrorBox: (title, text) => errors.push(`${title}: ${text}`) },
    );
    return { outcome, errors };
  }

  it("moves nothing in a development run without the e2e hooks", () => {
    fixture03();
    expect(start(false, false).errors).toEqual([]);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("shows the problem that stops the start", () => {
    fixture03();
    fs.symlinkSync(`somehost-${String(process.pid)}`, path.join(legacy, "SingletonLock"));
    expect(start(false, true).errors).toEqual([
      expect.stringMatching(/^Reload did not start: InnyTypes is still running/),
    ]);
  });

  it("shows the steps that failed, to be tried again at the next start", () => {
    fixture03();
    write(path.join(legacy, "node-red", "flows.json"), "{ not json");
    const { errors } = start(true, false);
    expect(errors).toEqual([
      expect.stringMatching(
        /^Reload could not finish moving the data of InnyTypes: flows: .*tries these again/s,
      ),
    ]);
  });
});

describe("the import report beside the move", () => {
  it("a report that holds only the move's steps does not stop the one-time import, and keeps them", () => {
    const store = new JsonLegacyImportReportStore(scratch);
    store.writeMove({ from: null, steps: { secrets: "done" } });
    expect(store.exists()).toBe(false);
    store.write({ importedAt: "now", launchAtLoginWanted: false, imported: [], ignored: [] });
    expect(store.exists()).toBe(true);
    expect(store.readMove()).toEqual({ from: null, steps: { secrets: "done" } });
  });
});
