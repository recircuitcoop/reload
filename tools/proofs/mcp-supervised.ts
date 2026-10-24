// proof mcp-supervised (plan 0018 §5.4): kill -9 of the MCP child restarts it; tools are
// served only after a fresh handshake; the breaker stops it after N exits. Against the
// packaged app (harness.ts), with the repo's fake MCP child and a fake Anytype.
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { DEFAULT_CRASH_LOOP } from "../../app/src/domain/supervision/breaker";
import { isAlive, processesNaming, waitForRunning } from "../../app/test/e2e/app-harness";
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

type Status = { state: string; childPid: number | null };

test("kill -9 of the MCP child restarts it; tools are served only after a fresh handshake; the breaker stops it after N exits", async () => {
  const { scratch, userData, env: base } = proofScratch();
  const anytype = await fakeAnytype();
  const env = withFakeMcp(base, scratch, anytype.url);
  let run: PackagedRun | null = null;
  const lines: string[] = [];
  try {
    run = await startPackaged(env);
    const page = run.page;
    await waitForRunning(page, "services");
    const status = async () => (await appCall(page, "anytypeStatus")) as Status;
    const url = `http://127.0.0.1:${String(env["RELOAD_MCP_PORT"])}/mcp`;
    await expect
      .poll(
        async () => ((await appCall(page, "mcpEndpoint")) as { served: string | null }).served,
        {
          timeout: 60_000,
        },
      )
      .toBe(url);
    const token = (await appCall(page, "mcpToken")) as string;
    expect(await rpcStatus(url, token, "tools/list")).toBe(200);
    const said = () => run?.output.join("") ?? "";
    const handshakes = () => said().match(/fake MCP child \d+ running on stdio/g)?.length ?? 0;

    // One kill -9: the endpoint answers 503 until a new child has shaken hands, then 200.
    const first = (await status()).childPid;
    expect(first).not.toBeNull();
    const before = handshakes();
    process.kill(first ?? 0, "SIGKILL");
    await expect.poll(() => rpcStatus(url, token, "tools/list"), { timeout: 10_000 }).toBe(503);
    await expect.poll(async () => (await status()).childPid, { timeout: 30_000 }).not.toBe(first);
    await expect.poll(() => rpcStatus(url, token, "tools/list"), { timeout: 30_000 }).toBe(200);
    expect(handshakes()).toBe(before + 1);
    expect(isAlive(first ?? 0)).toBe(false);
    lines.push(
      `kill -9 of MCP child ${String(first)}: endpoint 503, then child ${String((await status()).childPid)} started, shook hands, endpoint 200`,
    );

    // Kill every child the moment it is ready, until the breaker stops restarting it.
    let kills = 1;
    while (kills < DEFAULT_CRASH_LOOP.maxCrashes + 3) {
      const { childPid, state } = await status();
      if (state !== "ready" || childPid === null) {
        break;
      }
      process.kill(childPid, "SIGKILL");
      kills += 1;
      await expect
        .poll(
          async () => {
            const now = await status();
            return now.state === "ready"
              ? now.childPid !== childPid
              : now.state === "down-for-good";
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      if ((await status()).state === "down-for-good") {
        break;
      }
    }
    await expect
      .poll(async () => (await status()).state, { timeout: 30_000 })
      .toBe("down-for-good");
    expect(kills).toBe(DEFAULT_CRASH_LOOP.maxCrashes);
    expect(said()).toMatch(/notice: Reload is running without the Anytype MCP child: /);
    expect(await rpcStatus(url, token, "tools/list")).toBe(503);
    lines.push(
      `breaker: stopped after ${String(kills)} exits (maxCrashes ${String(DEFAULT_CRASH_LOOP.maxCrashes)}); ${String(said().match(/notice: Reload is running without the Anytype MCP child:[^\n]*/)?.[0])}`,
    );

    expect(await quitFromCommandLine(run, env)).toBe(0);
    await run.exited;
    await expect.poll(() => processesNaming(userData), { timeout: 15_000 }).toEqual([]);
    await run.browser.close().catch(() => undefined);
    run = null;
    evidence("mcp-supervised", lines);
  } finally {
    await stopRun(run, userData);
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
