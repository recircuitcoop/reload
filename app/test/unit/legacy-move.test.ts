// The first start of Reload over an InnyTypes 0.3.0 installation (plan 0028 step 1): the userData
// rename whichever case the old directory has on disk, the refusal while 0.3.0 still runs, the
// owner-only secret files moved at 0600 / 0700 with the owner's other files left alone, and the
// stored node types renamed.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  firstStartMove,
  LEGACY_USER_DATA_NAME,
  moveLegacySecrets,
  moveLegacyUserData,
  relocatedAfterMove,
  renamedNodeType,
  rewriteLegacyNodeTypes,
  setAsideFlowCredentials,
} from "../../src/adapters/fs/legacy-move";

let scratch: string;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-move-")));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Whether this scratch's file system ignores case (macOS and Windows by default). */
function caseInsensitive(): boolean {
  fs.writeFileSync(path.join(scratch, "probe"), "");
  return fs.existsSync(path.join(scratch, "PROBE"));
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("moveLegacyUserData", () => {
  it("renames 0.3.0's userData to Reload's, its files whole", () => {
    const legacy = path.join(scratch, LEGACY_USER_DATA_NAME);
    fs.mkdirSync(path.join(legacy, "node-red", "generated"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "shell-settings.json"), '{"telemetry":"off"}');
    fs.writeFileSync(path.join(legacy, "node-red", "generated", "inny-anytype-x.js"), "");
    const userData = path.join(scratch, "Reload");

    const outcome = moveLegacyUserData(legacy, userData);

    expect(outcome.problem).toBeNull();
    expect(outcome.moved).toEqual([`userData: ${legacy} -> ${userData}`]);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8")).toContain("off");
    // Generated modules are written again at start, never carried over.
    expect(fs.existsSync(path.join(userData, "node-red", "generated"))).toBe(false);
  });

  it("finds the old directory whatever its case on disk where the file system ignores case", () => {
    const onDisk = path.join(scratch, "innytypes"); // as the old Python app spelled it
    fs.mkdirSync(onDisk);
    fs.writeFileSync(path.join(onDisk, "config.toml"), "telemetry = false\n");
    const userData = path.join(scratch, "Reload");

    const outcome = moveLegacyUserData(path.join(scratch, LEGACY_USER_DATA_NAME), userData);

    if (caseInsensitive()) {
      expect(outcome.moved).toHaveLength(1);
      expect(fs.readFileSync(path.join(userData, "config.toml"), "utf8")).toContain("telemetry");
    } else {
      // A case-sensitive system's `innytypes` is the Python app's, never 0.3.0's userData.
      expect(outcome.moved).toEqual([]);
      expect(fs.existsSync(onDisk)).toBe(true);
    }
  });

  it("moves nothing when Reload already has its userData, or there is no old one", () => {
    const legacy = path.join(scratch, LEGACY_USER_DATA_NAME);
    const userData = path.join(scratch, "Reload");
    expect(moveLegacyUserData(legacy, userData)).toEqual({ moved: [], problem: null });
    fs.mkdirSync(legacy);
    fs.mkdirSync(userData);
    expect(moveLegacyUserData(legacy, userData)).toEqual({ moved: [], problem: null });
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("refuses while a running InnyTypes holds its single-instance lock (break it, watch it fail)", () => {
    const legacy = path.join(scratch, LEGACY_USER_DATA_NAME);
    fs.mkdirSync(legacy);
    fs.symlinkSync(`somehost-${String(process.pid)}`, path.join(legacy, "SingletonLock"));
    const userData = path.join(scratch, "Reload");

    const outcome = moveLegacyUserData(legacy, userData);

    expect(outcome.moved).toEqual([]);
    expect(outcome.problem).toContain("InnyTypes is still running");
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(userData)).toBe(false);
  });

  it("moves past a lock left by an InnyTypes that is no longer running", () => {
    const legacy = path.join(scratch, LEGACY_USER_DATA_NAME);
    fs.mkdirSync(legacy);
    fs.symlinkSync("somehost-2147483646", path.join(legacy, "SingletonLock"));
    expect(moveLegacyUserData(legacy, path.join(scratch, "Reload")).problem).toBeNull();
  });
});

describe("moveLegacySecrets", () => {
  const location = () => ({ platform: "linux" as const, home: scratch, env: {} });

  it("moves the key and the token to ~/.config/reload at 0600 in 0700, and leaves the owner's other files", () => {
    const old = path.join(scratch, ".config", "innytypes");
    fs.mkdirSync(old, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(old, "anytype_api_key"), "key", { mode: 0o600 });
    fs.writeFileSync(path.join(old, "mcp_proxy_token"), "token", { mode: 0o644 });
    fs.writeFileSync(path.join(old, "mcp-headers.sh"), "#!/bin/sh\n");
    fs.mkdirSync(path.join(old, "client-config-backups-1"));

    const lines = moveLegacySecrets(location());

    const target = path.join(scratch, ".config", "reload");
    expect(lines).toHaveLength(2);
    expect(fs.readFileSync(path.join(target, "anytype_api_key"), "utf8")).toBe("key");
    expect(fs.readFileSync(path.join(target, "mcp_proxy_token"), "utf8")).toBe("token");
    expect(mode(target)).toBe(0o700);
    expect(mode(path.join(target, "anytype_api_key"))).toBe(0o600);
    expect(mode(path.join(target, "mcp_proxy_token"))).toBe(0o600);
    expect(fs.existsSync(path.join(old, "anytype_api_key"))).toBe(false);
    expect(fs.existsSync(path.join(old, "mcp-headers.sh"))).toBe(true);
    expect(fs.existsSync(path.join(old, "client-config-backups-1"))).toBe(true);
    // Twice is once: nothing is left to move.
    expect(moveLegacySecrets(location())).toEqual([]);
  });

  it("keeps a file Reload already has, and takes the key from the oldest releases' place", () => {
    const target = path.join(scratch, ".config", "reload");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "mcp_proxy_token"), "new");
    const old = path.join(scratch, ".config", "innytypes");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "mcp_proxy_token"), "old");
    const darwin = { platform: "darwin" as const, home: scratch, env: {} };
    const legacyKey = path.join(scratch, "Library", "Application Support", "innytypes");
    fs.mkdirSync(legacyKey, { recursive: true });
    fs.writeFileSync(path.join(legacyKey, "anytype_api_key"), "older-key");

    moveLegacySecrets(darwin);

    expect(fs.readFileSync(path.join(target, "mcp_proxy_token"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(old, "mcp_proxy_token"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(target, "anytype_api_key"), "utf8")).toBe("older-key");
  });
});

describe("the stored node types", () => {
  it("renames every generated type, the renamed packages under their new names", () => {
    expect(renamedNodeType("inny-anytype-create-object")).toBe(
      "reload-reload_anytype-create-object",
    );
    expect(renamedNodeType("inny-folder-watch")).toBe("reload-reload_folder-watch");
    expect(renamedNodeType("inny-user-events-note-v1")).toBe("reload-user-events-note-v1");
    expect(renamedNodeType("inny-acme-step")).toBe("reload-acme-step");
    expect(renamedNodeType("inject")).toBe("inject");
    expect(renamedNodeType("subflow:abc")).toBe("subflow:abc");
  });

  it("rewrites flows.json in place, and leaves a file with nothing to rename untouched", () => {
    const flows = path.join(scratch, "flows.json");
    fs.writeFileSync(
      flows,
      JSON.stringify([
        { id: "t", type: "tab" },
        { id: "a", type: "inny-anytype-search", z: "t", wires: [] },
        { id: "w", type: "inny-folder-watch", z: "t", folder: "/x" },
      ]),
    );
    expect(rewriteLegacyNodeTypes(flows)).toBe(2);
    const nodes = JSON.parse(fs.readFileSync(flows, "utf8")) as { type: string; folder?: string }[];
    expect(nodes.map((node) => node.type)).toEqual([
      "tab",
      "reload-reload_anytype-search",
      "reload-reload_folder-watch",
    ]);
    expect(nodes[2]?.folder).toBe("/x");
    const before = fs.readFileSync(flows, "utf8");
    expect(rewriteLegacyNodeTypes(flows)).toBe(0);
    expect(fs.readFileSync(flows, "utf8")).toBe(before);
    expect(rewriteLegacyNodeTypes(path.join(scratch, "missing.json"))).toBe(0);
  });
});

describe("firstStartMove", () => {
  it("moves the userData, the secrets and the node types in one go", () => {
    const appData = path.join(scratch, "app-data");
    const legacy = path.join(appData, LEGACY_USER_DATA_NAME);
    fs.mkdirSync(path.join(legacy, "node-red"), { recursive: true });
    fs.writeFileSync(
      path.join(legacy, "node-red", "flows.json"),
      JSON.stringify([{ id: "w", type: "inny-folder-watch" }]),
    );
    const old = path.join(scratch, ".config", "innytypes");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "anytype_api_key"), "key");
    const userData = path.join(appData, "Reload");

    const outcome = firstStartMove({
      legacyUserData: legacy,
      userData,
      secrets: { platform: "linux", home: scratch, env: {} },
    });

    expect(outcome.problem).toBeNull();
    expect(outcome.movedUserData).toBe(true);
    expect(outcome.moved).toHaveLength(3);
    expect(fs.readFileSync(path.join(userData, "node-red", "flows.json"), "utf8")).toContain(
      "reload-reload_folder-watch",
    );
  });

  it("follows a path of the old Python app into the moved directory", () => {
    const legacy = path.join(scratch, LEGACY_USER_DATA_NAME);
    const userData = path.join(scratch, "Reload");
    fs.mkdirSync(userData);
    fs.writeFileSync(path.join(userData, "config.toml"), "");
    const lower = path.join(scratch, "innytypes", "config.toml");
    expect(relocatedAfterMove(lower, legacy, userData, "darwin")).toBe(
      path.join(userData, "config.toml"),
    );
    // Case matters on Linux, and a path elsewhere is never moved.
    expect(relocatedAfterMove(lower, legacy, userData, "linux")).toBe(lower);
    expect(relocatedAfterMove("/elsewhere/config.toml", legacy, userData, "darwin")).toBe(
      "/elsewhere/config.toml",
    );
  });

  it("sets aside the flow credentials a new credential secret cannot decrypt", () => {
    expect(setAsideFlowCredentials(scratch)).toBe(false);
    fs.mkdirSync(path.join(scratch, "node-red"));
    fs.writeFileSync(path.join(scratch, "node-red", "flows_cred.json"), "{}");
    expect(setAsideFlowCredentials(scratch)).toBe(true);
    expect(fs.existsSync(path.join(scratch, "node-red", "flows_cred.unreadable.json"))).toBe(true);
    expect(fs.existsSync(path.join(scratch, "node-red", "flows_cred.json"))).toBe(false);
  });
});
