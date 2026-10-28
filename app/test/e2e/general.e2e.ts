// Configuration › General in the real app (plan 0022 §M; WI-0022-18): every section's one-line
// state and actions from ux-writing.md, driven through the screen. Pairing with Anytype and the MCP
// endpoint's live move (the anytype and mcp-endpoint behaviours), See what would be sent in full,
// Advanced's status details, the Recorders and folders line, retention's five choices, and the
// AI apps rows' Connect, Disconnect and Repair.
//
// Never the owner's Anytype, key, port or AI apps' files: a fake Anytype on a free loopback port,
// the fake MCP child, a scratch HOME (app-harness) whose ~/.codex is the only one written, and
// free ports.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { NOTICE_VERSION } from "../../src/domain/telemetry/reports";
import { committedToolSurface, toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { STRINGS } from "../../src/ui/strings";
import { stubClaude } from "../fakes/claude-command";
import {
  anytypeKeyFile,
  APP,
  cleanUp,
  ELECTRON_BINARY,
  freePortNow,
  launchApp,
  openGeneral,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const KEY = "e2e-general-anytype-key-0123456789";
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");

/** A fake Anytype: pairing (code 1234), three spaces, and an empty answer to anything else. */
async function fakeAnytype(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      const url = request.url ?? "";
      if (url === "/v1/auth/challenges") {
        response.end('{"challenge_id":"e2e-challenge"}');
      } else if (url === "/v1/auth/api_keys") {
        const sent = JSON.parse(body) as { code?: string };
        response.statusCode = sent.code === "1234" ? 201 : 400;
        response.end(sent.code === "1234" ? JSON.stringify({ api_key: KEY }) : "{}");
      } else if (url.startsWith("/v1/spaces")) {
        response.end(
          JSON.stringify({
            data: ["Renaissance", "Fritte", "Home"].map((name, i) => ({
              id: `space-${String(i)}`,
              name,
              object: "space",
            })),
            pagination: { total: 3, offset: 0, limit: 100, has_more: false },
          }),
        );
      } else {
        response.end('{"data":[]}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as net.AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The fake child's surface, recorded the way the committed one is. */
function fakeSurface(scratch: string): string {
  const tools = JSON.parse(fs.readFileSync(path.join(FAKE, "tools.json"), "utf8")) as {
    name: string;
    inputSchema: unknown;
  }[];
  const file = path.join(scratch, "fake-surface.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      package_version: PACKAGE_VERSION,
      anytype_version: ANYTYPE_VERSION,
      source: "bundled-spec",
      captured_at: "e2e",
      tools: Object.fromEntries(tools.map((t) => [t.name, toolSignature(t.inputSchema)])),
    }),
  );
  return file;
}

/** The fake MCP child, so the endpoint is served without the real package. */
const fakeChild = (scratch: string) =>
  JSON.stringify({
    entry: path.join(FAKE, "server.mjs"),
    args: ["--mode=canary"],
    surface: fakeSurface(scratch),
  });

/** A section of General, by its kind. */
const section = (general: Locator, kind: string) => general.getByTestId(`general-section-${kind}`);

/** One JSON-RPC call to the endpoint, the way an independent client makes it: its status. */
async function rpcStatus(url: string, token: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(true);
    });
  });

test("General pairs with Anytype: Pair asks for the code, a wrong one is refused in words, the right one connects and the line counts the spaces", async () => {
  // Pairing waits on the services process and the MCP child's validation: slow on a busy machine.
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const apps: ElectronApplication[] = [];
  try {
    // No key to start with: Not paired yet.
    fs.rmSync(anytypeKeyFile(scratch));
    const { app, window } = await launchApp(
      {
        ...env,
        ANYTYPE_API_BASE_URL: anytype.url,
        RELOAD_TEST_ANYTYPE: fakeChild(scratch),
      },
      { allowedKeys: [KEY] },
    );
    apps.push(app);
    await waitForRunning(window, "services");
    const general = await openGeneral(window);
    const anytypeSection = section(general, "anytype");
    const state = general.getByTestId("general-anytype-state");
    await expect(state).toHaveText(STRINGS["general.anytype.notPaired"], { timeout: 15_000 });
    const pair = general.getByTestId("general-anytype-pair");
    await expect(pair).toHaveText(STRINGS["general.pair"]);

    // Pair: Anytype shows a code, and General asks for it.
    await pair.click();
    const code = general.getByTestId("general-anytype-code-input");
    await expect(code).toBeVisible();
    await expect(anytypeSection).toContainText(STRINGS["general.anytype.code"]);
    // The code form's submit says Connect, as Setup's does; the start button keeps its label, so
    // each button has a name of its own.
    const connect = general.getByTestId("general-anytype-connect");
    await expect(connect).toHaveText(STRINGS["setup.anytype.connect"]);
    await expect(pair).toHaveText(STRINGS["general.pair"]);
    // Each button has a name of its own: one says Connect, one says Pair.
    const said = await anytypeSection.evaluate((element) =>
      [...element.querySelectorAll("button")].map((button) => button.textContent),
    );
    expect(said.filter((words) => words === STRINGS["setup.anytype.connect"])).toHaveLength(1);
    expect(said.filter((words) => words === STRINGS["general.pair"])).toHaveLength(1);

    // A wrong code is refused with General's sentence; nothing is stored.
    await code.fill("12");
    await general.getByTestId("general-anytype-connect").click();
    await expect(general.getByTestId("general-anytype-message")).toHaveText(
      STRINGS["general.anytype.codeRefused"],
    );
    expect(fs.existsSync(anytypeKeyFile(scratch))).toBe(false);

    // The right code: stored owner-only, never on the page, and the line counts the spaces.
    await code.fill("1234");
    await general.getByTestId("general-anytype-connect").click();
    await expect(state).toHaveText("Connected · 3 spaces", { timeout: 20_000 });
    await expect(pair).toHaveText(STRINGS["general.pairAgain"]);
    await expect(general.getByTestId("general-anytype-code")).toHaveCount(0);
    expect(fs.readFileSync(anytypeKeyFile(scratch), "utf8")).toBe(KEY);
    expect(fs.statSync(anytypeKeyFile(scratch)).mode & 0o777).toBe(0o600);
    expect(await window.content()).not.toContain(KEY);
    // Never a path on the screen.
    expect(await anytypeSection.textContent()).not.toContain(scratch);
    await quit(app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("General's AI apps line names the address served, Change port moves it live and says so, a taken port is refused in words, and the endpoint answers at the new address", async () => {
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const blocker = net.createServer();
  const apps: ElectronApplication[] = [];
  try {
    const firstPort = Number(env["RELOAD_MCP_PORT"]);
    const { app, window } = await launchApp({
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      RELOAD_TEST_ANYTYPE: fakeChild(scratch),
    });
    apps.push(app);
    const general = await openGeneral(window);
    const state = general.getByTestId("general-ai-apps-state");
    // The address is drawn as code, its backticks not shown.
    await expect(state).toHaveText(
      `Claude, Codex and other apps can use your Anytype through Reload at 127.0.0.1:${String(firstPort)}.`,
      { timeout: 20_000 },
    );
    await expect(state.getByTestId("inline-code")).toHaveText(`127.0.0.1:${String(firstPort)}`);
    // Change port is pre-filled with the port served.
    const port = general.getByTestId("general-port-input");
    await expect(port).toHaveValue(String(firstPort));

    const tokenFile = path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    await expect
      .poll(() => rpcStatus(`http://127.0.0.1:${String(firstPort)}/mcp`, token), {
        timeout: 20_000,
      })
      .toBe(200);

    // A move: the new address serves, the old one is refused, the line and the field follow,
    // and General says apps need the new address.
    const secondPort = freePortNow();
    await port.fill(String(secondPort));
    await general.getByTestId("general-ai-apps-change").click();
    await expect(state).toContainText(`127.0.0.1:${String(secondPort)}`);
    await expect(general.getByTestId("general-ai-apps-message")).toHaveText(
      STRINGS["general.aiApps.moved"],
    );
    await expect(port).toHaveValue(String(secondPort));
    expect(await rpcStatus(`http://127.0.0.1:${String(secondPort)}/mcp`, token)).toBe(200);
    expect(await refused(firstPort)).toBe(true);

    // A port another program holds: refused with ux-writing's sentence, and nothing moves.
    const takenPort = freePortNow();
    await new Promise<void>((resolve) => blocker.listen(takenPort, "127.0.0.1", resolve));
    await port.fill(String(takenPort));
    await general.getByTestId("general-ai-apps-change").click();
    await expect(general.getByTestId("general-ai-apps-message")).toHaveText(
      `Port ${String(takenPort)} is used by another app. Choose another port.`,
    );
    await expect(state).toContainText(`127.0.0.1:${String(secondPort)}`);
    expect(await rpcStatus(`http://127.0.0.1:${String(secondPort)}/mcp`, token)).toBe(200);

    await quit(app);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

// ── one row per AI app (plan 0033 §C, WI-0033-04) ─────────────────────────────────────────
// Always in the scratch home (HOME is the scratch folder, os.homedir() honours it): the shared
// server list is the scratch's ~/.codex/config.toml, never the real one.

const OTHERS = '# mine\nmodel = "x"\n\n[mcp_servers.serena]\ncommand = "uvx"\n';
const HAND_MADE = `${OTHERS}\n[mcp_servers.reload]\nurl = "http://127.0.0.1:1/mcp"\nbearer_token_env_var = "MINE"\n`;

/** General again, so its rows read the list afresh. */
async function reopenGeneral(window: Page): Promise<Locator> {
  await window.evaluate(() => {
    globalThis.location.hash = "#/configuration/flows";
  });
  return openGeneral(window);
}

test("General's AI apps row: Connect writes Reload's entry, Disconnect takes only it out, an entry changed by hand offers Repair, and every line is said", async () => {
  test.setTimeout(150_000);
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const list = path.join(scratch, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(list));
  fs.writeFileSync(list, OTHERS);
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp({
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      RELOAD_TEST_ANYTYPE: fakeChild(scratch),
    });
    apps.push(app);
    let general = await openGeneral(window);
    const served = Number(env["RELOAD_MCP_PORT"]);
    await expect(general.getByTestId("general-ai-apps-state")).toContainText(
      `127.0.0.1:${String(served)}`,
      { timeout: 20_000 },
    );
    const row = (testId: string) => general.getByTestId(`general-ai-app-${testId}-codex`);
    await expect(row("name")).toHaveText("ChatGPT and Codex");
    await expect(row("state")).toHaveText(STRINGS["general.aiApps.notConnected"]);
    await expect(row("limit")).toHaveText(STRINGS["aiApps.limit.workView"]);
    await expect(row("company")).toHaveText("What the tools return is sent to OpenAI.");
    await expect(row("disconnect")).toHaveCount(0);
    await expect(row("repair")).toHaveCount(0);

    // Connect: Reload's table at the end, the served address in it, never a token.
    await expect(row("connect")).toHaveText(STRINGS["setup.aiApps.connect"]);
    await row("connect").click();
    await expect(row("state")).toHaveText(/^(Connected\.|Restart ChatGPT to finish\.)$/, {
      timeout: 15_000,
    });
    await expect(row("connect")).toHaveCount(0);
    const written = fs.readFileSync(list, "utf8");
    expect(written.startsWith(OTHERS)).toBe(true);
    expect(written).toContain(
      `[mcp_servers.reload]\nurl = "http://127.0.0.1:${String(served)}/mcp"\n`,
    );
    expect(written).toContain("http_headers_helper");
    expect(written).not.toMatch(/bearer|token/i);

    // Disconnect: every line that was there before is there as it was; only the blank line that
    // set Reload's table apart stays (domain/ai-apps/codex-config.ts).
    await expect(row("disconnect")).toHaveText(STRINGS["general.aiApps.disconnect"]);
    await row("disconnect").click();
    await expect(row("state")).toHaveText(STRINGS["general.aiApps.notConnected"]);
    expect(fs.readFileSync(list, "utf8")).toBe(`${OTHERS}\n`);

    // An entry written by hand: said, Connect is not offered, Repair puts Reload's back.
    fs.writeFileSync(list, HAND_MADE);
    general = await reopenGeneral(window);
    await expect(row("state")).toHaveText(STRINGS["setup.aiApps.changed"]);
    await expect(row("connect")).toHaveCount(0);
    await expect(row("repair")).toHaveText(STRINGS["setup.aiApps.repair"]);
    await row("repair").click();
    await expect(row("state")).toHaveText(/^(Connected\.|Restart ChatGPT to finish\.)$/, {
      timeout: 15_000,
    });
    const repaired = fs.readFileSync(list, "utf8");
    expect(repaired.startsWith(OTHERS)).toBe(true);
    expect(repaired).toContain("http_headers_helper");
    expect(repaired).not.toContain("MINE");
    await quit(app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("General's Claude Code row: Connect adds Reload's server through the claude command, Disconnect removes only it, and the row says where it is reached", async () => {
  test.setTimeout(150_000);
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  // The stub `claude` first on a PATH that holds no other one (app-harness), in the scratch home.
  const bin = path.join(scratch, "bin");
  const calls = stubClaude(bin);
  const list = path.join(scratch, ".claude.json");
  const others = { numStartups: 3, mcpServers: { serena: { command: "uvx" } }, projects: {} };
  fs.writeFileSync(list, `${JSON.stringify(others, null, 2)}\n`, { mode: 0o600 });
  const read = () => JSON.parse(fs.readFileSync(list, "utf8")) as typeof others;
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp({
      ...env,
      PATH: `${bin}${path.delimiter}${env["PATH"] ?? ""}`,
      ANYTYPE_API_BASE_URL: anytype.url,
      RELOAD_TEST_ANYTYPE: fakeChild(scratch),
    });
    apps.push(app);
    const general = await openGeneral(window);
    const served = Number(env["RELOAD_MCP_PORT"]);
    await expect(general.getByTestId("general-ai-apps-state")).toContainText(
      `127.0.0.1:${String(served)}`,
      { timeout: 20_000 },
    );
    const row = (testId: string) => general.getByTestId(`general-ai-app-${testId}-claude`);
    await expect(row("name")).toHaveText("Claude Code");
    await expect(row("state")).toHaveText(STRINGS["general.aiApps.notConnected"]);
    await expect(row("limit")).toHaveText(STRINGS["aiApps.limit.codeTab"]);
    await expect(row("company")).toHaveText("What the tools return is sent to Anthropic.");
    // The ChatGPT-only line is beside ChatGPT and Codex alone.
    await expect(general.getByTestId("general-ai-app-claude")).not.toContainText("Work view");

    await row("connect").click();
    await expect(row("state")).toHaveText(STRINGS["setup.aiApps.connected"], { timeout: 15_000 });
    const server = read().mcpServers as Record<string, Record<string, string>>;
    expect(server["reload"]?.["type"]).toBe("http");
    expect(server["reload"]?.["url"]).toBe(`http://127.0.0.1:${String(served)}/mcp`);
    expect(server["reload"]?.["headersHelper"]).toMatch(/^'\/.*\/mcp-helper\/reload-mcp-headers'$/);
    expect(Object.keys(server["reload"] ?? {}).sort()).toEqual(["headersHelper", "type", "url"]);
    expect(fs.readFileSync(list, "utf8")).not.toMatch(/bearer|token/i);
    expect(read().numStartups).toBe(3);
    expect(calls().map((call) => call.slice(0, 5))).toEqual([
      ["mcp", "add-json", "--scope", "user", "reload"],
    ]);

    await row("disconnect").click();
    await expect(row("state")).toHaveText(STRINGS["general.aiApps.notConnected"]);
    expect(read()).toEqual(others);
    expect(calls().at(-1)).toEqual(["mcp", "remove", "--scope", "user", "reload"]);
    await quit(app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("General's AI apps row: Connect before anything is served says that AI apps can't reach Anytype yet, and writes nothing", async () => {
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const list = path.join(scratch, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(list));
  const apps: ElectronApplication[] = [];
  try {
    // No Anytype answers and no MCP child is started: the endpoint serves no address.
    const { app, window } = await launchApp(env);
    apps.push(app);
    const general = await openGeneral(window);
    await expect(general.getByTestId("general-ai-apps-state")).toHaveText(
      STRINGS["general.aiApps.notServed"],
      { timeout: 20_000 },
    );
    await general.getByTestId("general-ai-app-connect-codex").click();
    await expect(general.getByTestId("general-ai-app-failed-codex")).toHaveText(
      STRINGS["aiApps.notServed"].replace("{app}", "ChatGPT and Codex"),
    );
    await expect(general.getByTestId("general-ai-app-state-codex")).toHaveText(
      STRINGS["general.aiApps.notConnected"],
    );
    expect(fs.existsSync(list)).toBe(false);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a taken MCP port at start is said in the terminal Reload was started from, and by reload --status", async () => {
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const blocker = net.createServer();
  const apps: ElectronApplication[] = [];
  try {
    // Taken before Reload starts: it comes up without its MCP endpoint, as the old host came up
    // without its MCP child.
    const port = Number(env["RELOAD_MCP_PORT"]);
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    const runEnv = {
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      RELOAD_TEST_ANYTYPE: fakeChild(scratch),
    };
    const { app, output } = await launchApp(runEnv);
    apps.push(app);
    await expect
      .poll(() => output.join(""), { timeout: 20_000 })
      .toMatch(/^ {2}not started MCP endpoint: .+$/m);
    const said = /^ {2}not started MCP endpoint: (.+)$/m.exec(output.join(""))?.[1] ?? "";
    // The same condition crossed to the notice file, and a third process prints it.
    const status = spawnSync(ELECTRON_BINARY, [APP, "--status"], {
      env: runEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`  Reload is running without its MCP endpoint — ${said}`);
    await quit(app);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("General's AI apps offers the host beside the port: a host that is not loopback is refused in words and nothing moves, one Change moves both live, and the stored address wins at the next start", async () => {
  test.setTimeout(120_000);
  const { scratch, userData, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const apps: ElectronApplication[] = [];
  try {
    const firstPort = Number(env["RELOAD_MCP_PORT"]);
    // The variable names the IPv4 host; the stored one must win over it at the next start.
    const runEnv = {
      ...env,
      RELOAD_MCP_HOST: "127.0.0.1",
      ANYTYPE_API_BASE_URL: anytype.url,
      RELOAD_TEST_ANYTYPE: fakeChild(scratch),
    };
    const { app, window } = await launchApp(runEnv);
    apps.push(app);
    const general = await openGeneral(window);
    const state = general.getByTestId("general-ai-apps-state");
    await expect(state).toContainText(`127.0.0.1:${String(firstPort)}`, { timeout: 20_000 });
    const host = general.getByTestId("general-host-input");
    const port = general.getByTestId("general-port-input");
    const change = general.getByTestId("general-ai-apps-change");
    const message = general.getByTestId("general-ai-apps-message");
    await expect(host).toHaveValue("127.0.0.1");
    await expect(port).toHaveValue(String(firstPort));
    await expect(change).toHaveText(STRINGS["general.aiApps.change"]);
    const token = fs
      .readFileSync(path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token"), "utf8")
      .trim();
    const first = `http://127.0.0.1:${String(firstPort)}/mcp`;
    await expect.poll(() => rpcStatus(first, token), { timeout: 20_000 }).toBe(200);

    // A wildcard and a name: each refused in words, and the first address still serves.
    for (const refusedHost of ["0.0.0.0", "localhost"]) {
      await host.fill(refusedHost);
      await change.click();
      await expect(message).toHaveText(STRINGS["general.aiApps.hostRefused"]);
      await expect(state).toContainText(`127.0.0.1:${String(firstPort)}`);
      expect(await rpcStatus(first, token)).toBe(200);
    }
    const settings = path.join(userData, "settings.json");
    const storedMcp = () =>
      fs.existsSync(settings)
        ? (JSON.parse(fs.readFileSync(settings, "utf8")) as { mcp?: unknown }).mcp
        : undefined;
    expect(storedMcp()).toBeUndefined();

    // One Change moves host and port together: IPv6 loopback serves, the old address is gone.
    const secondPort = freePortNow();
    const second = `http://[::1]:${String(secondPort)}/mcp`;
    await host.fill("::1");
    await port.fill(String(secondPort));
    await change.click();
    await expect(state).toContainText(`[::1]:${String(secondPort)}`);
    await expect(message).toHaveText(STRINGS["general.aiApps.moved"]);
    await expect(host).toHaveValue("::1");
    await expect(port).toHaveValue(String(secondPort));
    expect(await rpcStatus(second, token)).toBe(200);
    expect(await refused(firstPort)).toBe(true);
    expect(storedMcp()).toEqual({ host: "::1", port: secondPort });
    await quit(app);

    // The next start: the stored address wins over RELOAD_MCP_HOST and RELOAD_MCP_PORT.
    const again = await launchApp(runEnv);
    apps.push(again.app);
    const reopened = await openGeneral(again.window);
    await expect(reopened.getByTestId("general-ai-apps-state")).toContainText(
      `[::1]:${String(secondPort)}`,
      { timeout: 20_000 },
    );
    await expect(reopened.getByTestId("general-host-input")).toHaveValue("::1");
    await expect.poll(() => rpcStatus(second, token), { timeout: 20_000 }).toBe(200);
    expect(await refused(firstPort)).toBe(true);
    await quit(again.app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

/** Choose `value` in the retention Select, which says `label` (Ark: the trigger, then the option). */
async function chooseRetention(general: Locator, value: string, label: string): Promise<void> {
  await general.getByTestId("general-retention-select-trigger").click();
  const option = general.getByTestId(`general-retention-select-option-${value}`);
  await expect(option).toHaveText(label);
  await option.click();
}

test("General shows the queued reports in full, Advanced's status details, Recorders and folders with none watched, and keeps runs 7, 30, 90 or 365 days or Forever", async () => {
  const { scratch, userData, env } = scratchDirectories();
  // Reports are on, and their one endpoint never answers: this launch's usage report waits in
  // the queue, which is what See what would be sent shows.
  const closedPort = freePortNow();
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, "shell-settings.json"),
    JSON.stringify({
      telemetry: true,
      // The yes answered this version's privacy notice (plan 0029): it is not asked again.
      telemetryNotice: NOTICE_VERSION,
      setup: { step: "welcome", formIndex: 0, formCount: 0, completed: true },
    }),
  );
  const runEnv = {
    ...env,
    RELOAD_E2E_HOOKS: "1",
    RELOAD_TEST_MACHINE_ID: "E2E-GENERAL-MACHINE-7c1e",
    RELOAD_UMAMI_URL: `https://127.0.0.1:${String(closedPort)}/umami`,
    RELOAD_UMAMI_WEBSITE_ID: "e2e-site",
  };
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(runEnv);
    apps.push(first.app);
    const window = first.window;
    const runtime = await waitForRunning(window, "runtime");
    const general = await openGeneral(window);

    // ── AI apps: which Anytype tools exist, read with no key, so with no MCP child ──────────
    const seeTools = general.getByTestId("general-anytype-tools-see");
    await expect(seeTools).toHaveText(STRINGS["general.aiApps.tools.see"]);
    await seeTools.click();
    await expect(general.getByTestId("general-anytype-tool")).toHaveText(
      Object.keys(committedToolSurface(path.join(APP, "src", "adapters", "anytype")).tools).sort(),
    );
    await expect(seeTools).toHaveText(STRINGS["general.aiApps.tools.hide"]);
    await seeTools.click();
    await expect(general.getByTestId("general-anytype-tools")).toHaveCount(0);

    // ── Reports: the state, the crash caption, and the queued reports in full ───────────────
    await expect(general.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.on"],
    );
    await expect(general.getByTestId("general-reports-crash")).toHaveText(
      STRINGS["general.reports.crashNotYet"],
    );
    const see = general.getByTestId("general-reports-see");
    await expect(see).toHaveText(STRINGS["general.reports.see"]);
    await see.click();
    const sent = general.getByTestId("general-reports-sent");
    const queued = await window.evaluate(() =>
      (
        globalThis as unknown as {
          reload: {
            app: {
              telemetryReports(): Promise<{ kind: string; url: string; body: string }[]>;
            };
          };
        }
      ).reload.app.telemetryReports(),
    );
    // This launch's usage events (plan 0029: its first step, and app_start once both are up).
    expect(queued.length).toBeGreaterThan(0);
    expect(new Set(queued.map((request) => request.kind))).toEqual(new Set(["usage"]));
    // In full: each request's address and body, byte for byte as it would be posted.
    await expect(sent.getByTestId("general-reports-url")).toHaveText(
      queued.map((request) => request.url),
    );
    await expect(sent.getByTestId("general-reports-body")).toHaveText(
      queued.map((request) => request.body),
    );
    await expect(see).toHaveText(STRINGS["general.reports.hide"]);
    await expect(see).toHaveAttribute("aria-expanded", "true");
    // Off deletes what waits, and the list says nothing waits.
    await expect(general.getByTestId("general-reports-switch")).toContainText(
      STRINGS["general.reports.switch"],
    );
    await general.getByTestId("general-reports-switch").click();
    await expect(general.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.off"],
    );
    await expect(sent).toHaveText(STRINGS["general.reports.nothing"]);

    // ── The old Application tab's groups, each drawn here: Anytype (pairing, AI apps), the
    // installed plugins and the catalogue (Packages), the helper's numbers and its processes
    // (Advanced: Stability defaults and the node list, below).
    for (const kind of ["anytype", "ai-apps", "packages", "advanced"]) {
      await expect(section(general, kind)).toBeVisible();
    }

    // ── Advanced: each child's state, process, port and generation; the endpoint served ─────
    const advanced = general.getByTestId("general-advanced");
    // The services process starts beside the runtime, and on a loaded machine after it.
    await waitForRunning(window, "services");
    await expect(section(general, "advanced")).toContainText(STRINGS["general.advanced.line"]);
    const runtimeRow = advanced.getByTestId("general-child-runtime");
    await expect(runtimeRow).toHaveAttribute("data-state", "running");
    await expect(runtimeRow).toContainText(STRINGS["status.running"]);
    await expect(advanced.getByTestId("general-child-runtime-process")).toHaveText(
      `${String(runtime.pid)} · ${runtime.port} · ${String(runtime.generation)}`,
    );
    await expect(advanced.getByTestId("general-child-services")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(advanced.getByTestId("general-advanced-endpoint")).toContainText(
      `http://127.0.0.1:${env["RELOAD_MCP_PORT"] ?? ""}/mcp`,
      { timeout: 20_000 },
    );
    // The runtime's node processes (the old process list): no flow has a step, so none runs.
    const nodes = advanced.getByTestId("general-advanced-nodes");
    await expect(nodes).toContainText(STRINGS["general.advanced.nodes"]);
    await expect(nodes).toContainText(STRINGS["general.advanced.nodes.none"]);
    await expect(advanced.getByTestId("general-advanced-node")).toHaveCount(0);
    await expect(advanced.getByTestId("general-advanced-anytype")).toBeVisible();
    await expect(advanced.getByTestId("general-advanced-secrets")).toHaveAttribute(
      "data-backend",
      /^(keychain|file)$/,
    );
    // Where the log is, for support (plan 0031 group I); Show log reveals that very file, through
    // a stand-in for shell.showItemInFolder so no file manager opens on the machine running this.
    const logRow = advanced.getByTestId("general-advanced-log");
    await expect(logRow).toContainText(STRINGS["general.advanced.log"]);
    await expect(logRow).toContainText(scratch);
    await first.app.evaluate(({ shell }) => {
      shell.showItemInFolder = (file) => {
        (globalThis as { revealed?: string }).revealed = file;
      };
    });
    await expect(logRow.getByTestId("general-advanced-log-show")).toHaveText(
      STRINGS["general.advanced.log.show"],
    );
    await logRow.getByTestId("general-advanced-log-show").click();
    const revealed = () => first.app.evaluate(() => (globalThis as { revealed?: string }).revealed);
    await expect.poll(revealed).toMatch(/reload\.log$/);
    expect((await revealed())?.startsWith(scratch)).toBe(true);
    // Stability defaults (plan 0031): the documented limits, saved as the person's own into
    // shell-settings.json, and a bad one refused in words with nothing written.
    const limits = advanced.getByTestId("general-limits");
    const memory = limits.getByTestId("general-limits-memory_mb-input");
    await expect(memory).toHaveValue("1024");
    await memory.fill("4096");
    await limits.getByTestId("general-limits-save").click();
    await expect(limits.getByTestId("general-limits-message")).toHaveText(
      STRINGS["general.limits.saved"],
    );
    const storedLimits = () =>
      (
        JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8")) as {
          limits?: Record<string, number>;
        }
      ).limits;
    expect(storedLimits()).toMatchObject({ memory_mb: 4096, children: 32 });
    await limits.getByTestId("general-limits-children-input").fill("0");
    await limits.getByTestId("general-limits-save").click();
    await expect(limits.getByTestId("general-limits-message")).toHaveText(
      STRINGS["general.limits.refused"],
    );
    await expect(limits).toContainText(STRINGS["general.limits.notWhole"]);
    expect(storedLimits()).toMatchObject({ children: 32 });
    // The supervision numbers (plan 0032 group 9, the old helper form): each field with its
    // label and its explanation drawn, and the restart delays one comma-separated text field.
    for (const key of ["check", "stopTimeout", "attempts", "backoff", "breakerWindow"] as const) {
      await expect(limits).toContainText(STRINGS[`general.limits.${key}`]);
      await expect(limits).toContainText(STRINGS[`general.limits.${key}.help`]);
    }
    await expect(limits).toContainText(STRINGS["general.limits.memory.help"]);
    await limits.getByTestId("general-limits-children-input").fill("32");
    const delays = limits.getByTestId("general-limits-restart_backoff_s-input");
    await expect(delays).toHaveAttribute("type", "text");
    await expect(delays).toHaveValue("1, 2, 4, 8, 16");
    const storedStability = () =>
      (
        JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8")) as {
          stability?: Record<string, unknown>;
        }
      ).stability;
    const savedBefore = storedStability();
    // A word among the delays is refused in words, with nothing written.
    await delays.fill("1, soon, 4");
    await limits.getByTestId("general-limits-save").click();
    await expect(limits.getByTestId("general-limits-message")).toHaveText(
      STRINGS["general.limits.refused"],
    );
    await expect(limits).toContainText(STRINGS["general.limits.notList"]);
    expect(storedStability()).toEqual(savedBefore);
    // A draft survives leaving General and coming back, and is not saved by it.
    await delays.fill("1, 2.5, 4");
    await limits.getByTestId("general-limits-check_s-input").fill("2.5");
    const goTo = (hash: string) =>
      window.evaluate((to) => {
        globalThis.location.hash = to;
      }, hash);
    await goTo("#/configuration/flows");
    await expect(window.getByTestId("general")).toHaveCount(0);
    await goTo("#/configuration/general");
    await expect(limits.getByTestId("general-limits-check_s-input")).toHaveValue("2.5");
    await expect(delays).toHaveValue("1, 2.5, 4");
    expect(storedStability()).toEqual(savedBefore);
    await limits.getByTestId("general-limits-save").click();
    await expect(limits.getByTestId("general-limits-message")).toHaveText(
      STRINGS["general.limits.saved"],
    );
    expect(storedStability()).toMatchObject({ check_s: 2.5, restart_backoff_s: [1, 2.5, 4] });
    // A restart is followed: the runtime's next generation shows without a reload.
    process.kill(runtime.pid, "SIGKILL");
    const next = await waitForRunning(window, "runtime", runtime.generation + 1);
    await expect(advanced.getByTestId("general-child-runtime-process")).toHaveText(
      `${String(next.pid)} · ${next.port} · ${String(next.generation)}`,
      { timeout: 15_000 },
    );

    // ── Recorders and folders: no folder source in any flow, so none is watched ────────────
    await expect(general.getByTestId("general-recorders-state")).toHaveText(
      STRINGS["general.recorders.none"],
    );

    // ── Retention (D8): 90 days unless changed; each of the five choices is kept ────────────
    const runsState = general.getByTestId("general-runs-state");
    await expect(runsState).toHaveText("Runs are kept for 90 days.");
    const stored = () =>
      (
        JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8")) as {
          runs?: { retentionDays?: number | null };
        }
      ).runs?.retentionDays;
    for (const [label, days, line] of [
      ["7 days", 7, "Runs are kept for 7 days."],
      ["30 days", 30, "Runs are kept for 30 days."],
      ["365 days", 365, "Runs are kept for 365 days."],
      ["90 days", 90, "Runs are kept for 90 days."],
      ["Forever", null, "Runs are kept until you delete them."],
    ] as const) {
      await chooseRetention(general, days === null ? "forever" : String(days), label);
      await expect(runsState, label).toHaveText(line);
      await expect.poll(stored, { message: label }).toBe(days);
    }

    await general.getByTestId("general-add-folder").click();
    await expect
      .poll(() => window.evaluate(() => globalThis.location.hash))
      .toBe("#/configuration/flows");
    await quit(first.app);

    // The next launch reads Forever back.
    const second = await launchApp(runEnv);
    apps.push(second.app);
    const again = await openGeneral(second.window);
    await expect(again.getByTestId("general-runs-state")).toHaveText(
      "Runs are kept until you delete them.",
    );
    await expect(again.getByTestId("general-retention")).toHaveAttribute("data-value", "forever");
    await quit(second.app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("General's Recorders and folders lists each folder source by its folder's name, watching while its flow is on, and says none is watched only when there is none", async () => {
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await waitForRunning(window, "runtime");
    const general = await openGeneral(window);
    const state = general.getByTestId("general-recorders-state");
    await expect(state).toHaveText(STRINGS["general.recorders.none"], { timeout: 15_000 });

    // The starter, folder to Anytype: its folder source set to a folder in the scratch home.
    const watched = path.join(scratch, "Recordings");
    fs.mkdirSync(watched);
    const step = await window.evaluate(async (folder) => {
      type Flow = { id: string; sources: { id: string; type: string }[] };
      const api = (
        globalThis as unknown as {
          reload: {
            app: {
              flowFromTemplate(id: string): Promise<{ ok: boolean; value: { id: string } }>;
              flows(): Promise<{ ok: boolean; value: Flow[] }>;
              configureNode(
                flowId: string,
                nodeId: string,
                values: Record<string, unknown>,
              ): Promise<{ ok: boolean }>;
            };
          };
        }
      ).reload.app;
      // A flow write waits for the canvas to finish loading ("loading"): asked again until then.
      let made = await api.flowFromTemplate("folder-to-anytype");
      for (let tries = 0; !made.ok && tries < 60; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        made = await api.flowFromTemplate("folder-to-anytype");
      }
      if (!made.ok) return { made: JSON.stringify(made), configured: false, flowId: "" };
      const flows = await api.flows();
      const flow = flows.value.find((each) => each.id === made.value.id);
      const source = flow?.sources.find((each) => each.type === "reload-reload_folder-watch");
      const configured = await api.configureNode(made.value.id, source?.id ?? "", { folder });
      return {
        made: made.ok,
        configured: configured.ok,
        flowId: made.value.id,
      };
    }, watched);
    expect(step).toMatchObject({ made: true, configured: true });

    // A new flow is off: its folder is listed, by name, not watched.
    const line = general.getByTestId("general-recorder");
    await expect(line).toHaveText("Recordings · not watching: its flow is off", {
      timeout: 15_000,
    });
    await expect(state).not.toContainText(STRINGS["general.recorders.none"]);
    await expect(state).not.toContainText(scratch);

    // Switched on: watching.
    const on = await window.evaluate(
      (flowId) =>
        (
          globalThis as unknown as {
            reload: { app: { setFlowOn(id: string, on: boolean): Promise<{ ok: boolean }> } };
          }
        ).reload.app.setFlowOn(flowId, true),
      step.flowId,
    );
    expect(on.ok).toBe(true);
    await expect(line).toHaveText("Recordings · watching", { timeout: 15_000 });
    await expect(line).toHaveCount(1);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
