// proof endpoint-moved (plan 0018 §5.4): moving the endpoint to another port while a Codex-like
// client runs closes the old port only after the new one binds; a collision is refused and the
// old endpoint kept. Against the packaged app (harness.ts), with the repo's fake MCP child.
import fs from "node:fs";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "@playwright/test";
import { freePortNow, processesNaming, waitForRunning } from "../../app/test/e2e/app-harness";
import {
  appCall,
  evidence,
  fakeAnytype,
  proofScratch,
  quitFromCommandLine,
  rpcStatus,
  startPackaged,
  stopRun,
  withFakeMcp,
  type PackagedRun,
} from "./harness";

/** An MCP client session against `url`, as Codex holds one: the SDK's streamable HTTP. */
async function codexLike(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "codex-like", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

test("moving the endpoint while a Codex-like client runs closes the old port only after the new one binds; a collision is refused and the old kept", async () => {
  const { scratch, userData, env: base } = proofScratch();
  const anytype = await fakeAnytype();
  const env = withFakeMcp(base, scratch, anytype.url);
  const blocker = net.createServer();
  let run: PackagedRun | null = null;
  try {
    run = await startPackaged(env);
    const page = run.page;
    await waitForRunning(page, "services");
    const firstPort = Number(env["RELOAD_MCP_PORT"]);
    const first = `http://127.0.0.1:${String(firstPort)}/mcp`;
    const served = async () =>
      ((await appCall(page, "mcpEndpoint")) as { served: string | null }).served;
    await expect.poll(served, { timeout: 60_000 }).toBe(first);
    const token = (await appCall(page, "mcpToken")) as string;
    const client = await codexLike(first, token);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("API-list-spaces");

    // The old port is watched throughout the move: the first time it does not serve, the new
    // one must already be serving (bound before the old closed).
    const secondPort = freePortNow();
    const second = `http://127.0.0.1:${String(secondPort)}/mcp`;
    // An object, so the loop below sees the flag the test flips after the move.
    const watch = { on: true };
    let oldServed = 0;
    let atClose: { old: number; new: number } | null = null;
    const watcher = (async () => {
      while (watch.on) {
        const old = await rpcStatus(first, token, "tools/list");
        if (old === 200) {
          oldServed += 1;
          continue;
        }
        atClose = { old, new: await rpcStatus(second, token, "tools/list") };
        return;
      }
    })();
    const moved = (await appCall(page, "moveMcpEndpoint", "127.0.0.1", secondPort)) as {
      served: string;
    };
    await expect.poll(() => atClose, { timeout: 10_000 }).not.toBeNull();
    watch.on = false;
    await watcher;
    expect(moved.served).toBe(second);
    expect(oldServed).toBeGreaterThan(0);
    expect(atClose).toEqual({ old: 0, new: 200 });
    expect(await rpcStatus(second, token, "tools/list")).toBe(200);
    expect(await rpcStatus(first, token, "tools/list")).toBe(0);
    // The client, pointed at the new address as the warning asks, lists the same tools.
    await client.close();
    const again = await codexLike(second, token);
    expect((await again.listTools()).tools.length).toBe(listed.tools.length);

    // A collision is refused, naming the address, and the endpoint stays where it was.
    const takenPort = freePortNow();
    await new Promise<void>((resolve) => blocker.listen(takenPort, "127.0.0.1", resolve));
    const refused = await appCall(page, "moveMcpEndpoint", "127.0.0.1", takenPort).then(
      () => "moved",
      (error: unknown) => String(error),
    );
    expect(refused).toContain(`127.0.0.1:${String(takenPort)}`);
    expect(await served()).toBe(second);
    expect((await again.listTools()).tools.length).toBe(listed.tools.length);
    await again.close();

    expect(await quitFromCommandLine(run, env)).toBe(0);
    await run.exited;
    await expect.poll(() => processesNaming(userData), { timeout: 15_000 }).toEqual([]);
    await run.browser.close().catch(() => undefined);
    run = null;
    evidence("endpoint-moved", [
      `a Codex-like MCP SDK client listed ${String(listed.tools.length)} tools at ${first}`,
      `moved to ${second}: the old port served ${String(oldServed)} calls during the move; the first time it refused, the new one already answered 200`,
      `move to taken 127.0.0.1:${String(takenPort)} refused (${refused.slice(0, 200)}); still served at ${second}, the client still listing`,
    ]);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await stopRun(run, userData);
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
