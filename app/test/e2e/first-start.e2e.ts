// The first start of Reload over a fixture InnyTypes 0.3.0 installation (plan 0028 step 1): the
// old userData directory becomes Reload's with its flows and settings, the Anytype key and the MCP
// token move to Reload's own owner-only directory (the owner's other files there stay), the
// bundled packages' node types in the stored flows are renamed, and an unreadable Node-RED
// credential secret is replaced with a notice instead of stopping the start.
//
// Never the owner's own installation: the fixture lives in the scratch home and a scratch app
// data directory (RELOAD_TEST_APP_DATA, honoured only with the e2e hooks on), and the keychain is
// Chromium's mock one.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  anytypeKeyFile,
  launchApp,
  quit,
  scratchDirectories,
  type RunningApp,
} from "./app-harness";

interface Delivered {
  title: string;
  body: string;
}
interface Hooks {
  reloadE2E: { notices: { list(): Delivered[] } };
}
interface PageApi {
  reload: {
    app: {
      flows(): Promise<{ value?: { id: string; name: string }[] }>;
      anytypeStatus(): Promise<{ state: string }>;
    };
  };
}

const delivered = (app: ElectronApplication): Promise<Delivered[]> =>
  app.evaluate(() => (globalThis as unknown as Hooks).reloadE2E.notices.list());
const flows = (window: Page) =>
  window.evaluate(() => (window as unknown as PageApi).reload.app.flows());
const anytypeState = (window: Page) =>
  window.evaluate(
    async () => (await (window as unknown as PageApi).reload.app.anytypeStatus()).state,
  );

const mode = (file: string) => fs.statSync(file).mode & 0o777;
const write = (file: string, text: string, fileMode?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, fileMode === undefined ? {} : { mode: fileMode });
};

test("the first start over InnyTypes 0.3.0 keeps its flows, settings and Anytype pairing", async () => {
  const base = scratchDirectories();
  const { scratch, canaryKey } = base;
  const appData = path.join(scratch, "app-data");
  // As it is on the owner's Mac: lowercase on disk, where the file system ignores case.
  const legacy = path.join(appData, process.platform === "darwin" ? "innytypes" : "InnyTypes");
  const userData = path.join(appData, "Reload");

  // ── the fixture 0.3.0 installation ───────────────────────────────────────────────────
  const watched = path.join(scratch, "watched");
  fs.mkdirSync(watched);
  const flowsFile = path.join(legacy, "node-red", "flows.json");
  write(
    flowsFile,
    JSON.stringify([
      { id: "t1", type: "tab", label: "Recordings", disabled: false },
      { id: "w1", type: "inny-folder-watch", z: "t1", folder: watched, wires: [["f1"]] },
      { id: "f1", type: "inny-anytype-create-object", z: "t1", space_id: "s1", wires: [[]] },
    ]),
  );
  write(path.join(legacy, "node-red", "flows_cred.json"), '{"$":"0123abcd"}');
  write(path.join(legacy, "node-red", "generated", "inny-anytype-create-object.js"), "throw 1;\n");
  const port = Number(base.env["RELOAD_MCP_PORT"]);
  write(path.join(legacy, "settings.json"), JSON.stringify({ mcp: { port } }));
  write(
    path.join(legacy, "shell-settings.json"),
    JSON.stringify({
      telemetry: false,
      // 0.3.0's install record: kept, Reload would offer to "go back" to 0.3.0.
      appUpdate: {
        lastVersion: "0.3.0",
        lastCheckedAt: null,
        previous: "0.2.1",
        goingBackTo: null,
      },
    }),
  );
  write(
    path.join(legacy, "legacy-import-report.json"),
    JSON.stringify({
      importedAt: "2026-10-15T00:00:00Z",
      launchAtLoginWanted: false,
      imported: [],
      ignored: [],
    }),
  );
  // A ciphertext the mock keychain cannot decrypt: what the renamed app meets on a real Mac.
  write(path.join(legacy, "secrets", "node-red-credential-secret.enc"), "bm90LWEtYmxvYg==", 0o600);
  // The secret files where InnyTypes kept them, with the owner's own files beside them.
  const oldSecrets = path.join(scratch, ".config", "innytypes");
  fs.mkdirSync(oldSecrets, { recursive: true, mode: 0o700 });
  fs.renameSync(anytypeKeyFile(scratch), path.join(oldSecrets, "anytype_api_key"));
  fs.rmSync(path.dirname(anytypeKeyFile(scratch)), { recursive: true });
  write(path.join(oldSecrets, "mcp_proxy_token"), "existing-token-0123456789abcdef", 0o600);
  write(path.join(oldSecrets, "mcp-headers.sh"), "#!/bin/sh\n", 0o700);

  const env = {
    ...base.env,
    RELOAD_USER_DATA: userData,
    RELOAD_TEST_APP_DATA: appData,
    RELOAD_E2E_HOOKS: "1",
  };
  let app: RunningApp | undefined;
  try {
    app = await launchApp(env, { allowedKeys: [canaryKey] });
    const first = app;
    const { window } = first;

    // The directory moved whole, whatever its case was.
    expect(fs.existsSync(path.join(appData, "InnyTypes"))).toBe(false);
    expect(fs.existsSync(path.join(userData, "shell-settings.json"))).toBe(true);

    // The flows are there, their bundled node types renamed.
    await expect
      .poll(async () => (await flows(window)).value?.map((flow) => flow.name), { timeout: 20_000 })
      .toEqual(["Recordings"]);
    const stored = JSON.parse(
      fs.readFileSync(path.join(userData, "node-red", "flows.json"), "utf8"),
    ) as { id: string; type: string }[];
    expect(Object.fromEntries(stored.map((node) => [node.id, node.type]))).toMatchObject({
      w1: "reload-reload_folder-watch",
      f1: "reload-reload_anytype-create-object",
    });
    expect(
      fs.existsSync(path.join(userData, "node-red", "generated", "inny-anytype-create-object.js")),
    ).toBe(false);

    // The settings: the endpoint is served at the port 0.3.0 stored.
    const settings = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")) as {
      mcp: { port: number };
    };
    expect(settings.mcp.port).toBe(port);

    // The Anytype pairing: the key moved to ~/.config/reload, owner-only, and it is the one read.
    const newKey = anytypeKeyFile(scratch);
    expect(fs.readFileSync(newKey, "utf8")).toBe(canaryKey);
    expect(mode(newKey)).toBe(0o600);
    expect(mode(path.dirname(newKey))).toBe(0o700);
    expect(fs.readFileSync(path.join(path.dirname(newKey), "mcp_proxy_token"), "utf8")).toBe(
      "existing-token-0123456789abcdef",
    );
    expect(fs.existsSync(path.join(oldSecrets, "anytype_api_key"))).toBe(false);
    expect(fs.existsSync(path.join(oldSecrets, "mcp-headers.sh"))).toBe(true);
    await expect
      .poll(() => anytypeState(window), { timeout: 20_000 })
      .not.toMatch(/^(no-key|starting)$/);

    // The credential secret could not be read: a new one, the old credentials set aside, one notice.
    await expect
      .poll(async () => (await delivered(first.app)).map((notice) => notice.title), {
        timeout: 15_000,
      })
      .toContain("Enter the credentials in your flows again");
    const setAside = fs
      .readdirSync(path.join(userData, "node-red"))
      .filter((name) => name.startsWith("flows_cred.unreadable-"));
    expect(setAside).toHaveLength(1);

    // The install record starts at Reload's own version: nothing to go back to.
    const shellSettings = JSON.parse(
      fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"),
    ) as { telemetry: boolean; appUpdate?: { lastVersion: string; previous: string | null } };
    expect(shellSettings.telemetry).toBe(false);
    expect(shellSettings.appUpdate?.lastVersion ?? "none").not.toBe("0.3.0");
    expect(shellSettings.appUpdate?.previous ?? null).toBeNull();

    // The move is in the import report, and the import itself did not run again.
    const report = JSON.parse(
      fs.readFileSync(path.join(userData, "legacy-import-report.json"), "utf8"),
    ) as { importedAt: string; moved: string[] };
    expect(report.importedAt).toBe("2026-10-15T00:00:00Z");
    expect(report.moved.some((line) => line.startsWith("userData: "))).toBe(true);
    expect(report.moved.some((line) => line.startsWith("anytype_api_key: "))).toBe(true);

    await quit(app.app);
    app = undefined;

    // A second start moves nothing and asks for nothing again.
    app = await launchApp(env, { allowedKeys: [canaryKey] });
    const second = app;
    await expect
      .poll(async () => (await flows(second.window)).value?.map((flow) => flow.name), {
        timeout: 20_000,
      })
      .toEqual(["Recordings"]);
    const again = JSON.parse(
      fs.readFileSync(path.join(userData, "legacy-import-report.json"), "utf8"),
    ) as { moved: string[] };
    expect(again.moved).toEqual(report.moved);
    expect((await delivered(second.app)).map((notice) => notice.title)).not.toContain(
      "Enter the credentials in your flows again",
    );
  } finally {
    if (app !== undefined) {
      await quit(app.app);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
