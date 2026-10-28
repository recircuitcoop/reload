// "Tell AI apps the names of my spaces" through the real app (plan 0033 D, decision D2): on by
// default, the live names are in the next connection's initialize instructions and tools/list
// descriptions; turned off in Configuration › General › AI apps, the next connection carries
// none, and the setting is stored in the services' settings.json. Names never reach the logs.
//
// Never the owner's Anytype, key or home: a fake Anytype that lists two spaces, the fake MCP
// child, a scratch HOME, and a free loopback port.
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type Page } from "@playwright/test";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { STRINGS } from "../../src/ui/strings";
import {
  anytypeKeyFile,
  APP,
  launchApp,
  openGeneral,
  processesNaming,
  quit,
  scratchDirectories,
} from "./app-harness";

const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");
const NAMES = ["Garden Notes", "Tax Papers"];

/** A fake Anytype that lists NAMES as its spaces and answers every other path with nothing. */
async function fakeAnytype(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const spaces = (request.url ?? "").startsWith("/v1/spaces?");
    response.end(
      JSON.stringify({
        data: spaces ? NAMES.map((name, i) => ({ id: `space-${String(i)}`, name })) : [],
      }),
    );
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

const served = (window: Page) =>
  window.evaluate(() =>
    (
      window as unknown as {
        reload: { app: { mcpEndpoint(): Promise<{ served: string | null }> } };
      }
    ).reload.app.mcpEndpoint(),
  );

/** One new connection, as an AI app makes it: what initialize and tools/list send. */
async function connection(url: string, token: string): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const mcp = new Client({ name: "an independent client", version: "1" });
  // The SDK's own types disagree with exactOptionalPropertyTypes (sessionId?: string).
  await mcp.connect(transport as Parameters<Client["connect"]>[0]);
  try {
    const instructions = mcp.getInstructions() ?? "";
    expect(instructions).toContain("the user's own Anytype");
    return JSON.stringify({ instructions, tools: (await mcp.listTools()).tools });
  } finally {
    await mcp.close();
  }
}

test("turning off the space names switch leaves them out of the next connection", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  try {
    const { app, window, output } = await launchApp({
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      RELOAD_TEST_ANYTYPE: JSON.stringify({
        entry: path.join(FAKE, "server.mjs"),
        surface: fakeSurface(scratch),
      }),
    });
    const url = `http://127.0.0.1:${env["RELOAD_MCP_PORT"] ?? ""}/mcp`;
    await expect.poll(async () => (await served(window)).served, { timeout: 20_000 }).toBe(url);
    const tokenFile = path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token");
    const token = fs.readFileSync(tokenFile, "utf8").trim();

    // On by default (D2): the names are in the instructions and the tool descriptions.
    const before = await connection(url, token);
    for (const name of NAMES) {
      expect(before).toContain(name);
    }

    // The switch in Configuration › General › AI apps, with its one line on what it sends.
    const general = await openGeneral(window);
    const section = general.getByTestId("general-section-ai-apps");
    const names = section.getByTestId("general-space-names");
    await expect(names).toHaveAttribute("data-on", "true");
    await expect(section.getByTestId("general-space-names-switch")).toContainText(
      STRINGS["general.aiApps.spaceNames"],
    );
    await expect(section.getByTestId("general-space-names-what")).toHaveText(
      STRINGS["general.aiApps.spaceNames.what"],
    );
    await section.getByTestId("general-space-names-switch").click();
    await expect(names).toHaveAttribute("data-on", "false");
    await expect(section.getByTestId("general-space-names-switch-input")).not.toBeChecked();
    const stored = () =>
      JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")) as Record<
        string,
        unknown
      >;
    expect(stored()["spaceNamesToAiApps"]).toBe(false);

    // Off: the next connection carries no name, in initialize or in tools/list.
    const after = await connection(url, token);
    for (const name of NAMES) {
      expect(after).not.toContain(name);
    }
    expect(after).toContain("anytype_list_spaces");

    // On again: the names are back at the next connection.
    await section.getByTestId("general-space-names-switch").click();
    await expect(names).toHaveAttribute("data-on", "true");
    expect(await connection(url, token)).toContain(NAMES[0]);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    // The names went to the connections and nowhere else the app writes.
    const printed = output.join("");
    for (const name of NAMES) {
      expect(printed).not.toContain(name);
    }
  } finally {
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
