// proof refusal-notices (plan 0018 §5.4): no key, Anytype not running, port taken, a
// non-loopback address: each shows its notice once. Against the packaged app (harness.ts).
//
// "Shows" is what the shell's NoticeBoard does: the notice is logged as `notice: <title>: <body>`
// once as it is handed to the desktop, and written to notices.json before that. No key is not a
// desktop notice in this app: it is the Anytype state the window shows (Settings says Not
// paired yet.), logged once; this proof holds it to that.
import fs from "node:fs";
import net from "node:net";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { anytypeKeyFile, processesNaming } from "../../app/test/e2e/app-harness";
import {
  appCall,
  evidence,
  fakeAnytype,
  withFakeMcp,
  proofScratch,
  quitFromCommandLine,
  startPackaged,
  stopRun,
  type PackagedRun,
} from "./harness";

/** How long a run is watched after its notice, for a second one that must not come. */
const SETTLE_MS = 15_000;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** Start, wait for `pattern` in the log, watch for a repeat, quit; the run's log. */
async function runUntil(env: Record<string, string>, userData: string, pattern: RegExp) {
  let run: PackagedRun | null = null;
  try {
    run = await startPackaged(env);
    const said = () => run?.output.join("") ?? "";
    await expect.poll(() => count(said(), pattern), { timeout: 60_000 }).toBeGreaterThan(0);
    // Asked again, as Check again and coming back to Reload ask: still the one notice.
    await appCall(run.page, "checkAnytype");
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const anytype = (await appCall(run.page, "anytypeStatus")) as { state: string };
    const endpoint = (await appCall(run.page, "mcpEndpoint")) as { problem: string | null };
    // Written once a notice is current: a run with none has no file.
    const file = path.join(userData, "notices.json");
    const notices = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    expect(await quitFromCommandLine(run, env)).toBe(0);
    await run.exited;
    await expect.poll(() => processesNaming(userData), { timeout: 15_000 }).toEqual([]);
    await run.browser.close().catch(() => undefined);
    const log = said();
    run = null;
    return { log, anytype, endpoint, notices };
  } finally {
    await stopRun(run, userData);
  }
}

test("no key, Anytype not running, port taken, non-loopback address: each shows its notice once", async () => {
  const lines: string[] = [];

  // No key: the Anytype state no-key, said once, and no desktop notice about Anytype.
  {
    const { scratch, userData, env } = proofScratch();
    try {
      fs.rmSync(anytypeKeyFile(scratch));
      const noKey = /anytype: no-key \(no Anytype API key in /g;
      const { log, anytype } = await runUntil(env, userData, noKey);
      expect(count(log, noKey)).toBe(1);
      expect(anytype.state).toBe("no-key");
      expect(log).not.toMatch(/notice: Reload cannot reach Anytype/);
      lines.push(
        `no key: state ${anytype.state}, logged once: ${String(log.match(/anytype: no-key[^\n]*/)?.[0])}`,
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // Anytype not running: a key, and nothing answering at Anytype's address.
  {
    const { scratch, userData, env } = proofScratch();
    try {
      const unreachable = /notice: Reload cannot reach Anytype:/g;
      const { log, anytype, notices } = await runUntil(env, userData, unreachable);
      expect(count(log, unreachable)).toBe(1);
      expect(anytype.state).toBe("unreachable");
      expect(notices).toContain("anytype-unreachable");
      lines.push(
        `Anytype not running: ${String(log.match(/notice: Reload cannot reach Anytype:[^\n]*/)?.[0])} (once; notices.json has anytype-unreachable)`,
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // The endpoint opens only for a validated MCP child: the repo's fake one, a fake Anytype.
  const anytype = await fakeAnytype();

  // Port taken: something else holds the MCP port before Reload starts.
  {
    const { scratch, userData, env: base } = proofScratch();
    const env = withFakeMcp(base, scratch, anytype.url);
    const blocker = net.createServer();
    try {
      await new Promise<void>((resolve) =>
        blocker.listen(Number(env["RELOAD_MCP_PORT"]), "127.0.0.1", resolve),
      );
      const degraded = /notice: Reload is running without its MCP endpoint:/g;
      const { log, endpoint, notices } = await runUntil(env, userData, degraded);
      expect(count(log, degraded)).toBe(1);
      expect(endpoint.problem).toContain(env["RELOAD_MCP_PORT"]);
      expect(notices).toContain("endpoint-degraded");
      lines.push(
        `port taken: ${String(log.match(/notice: Reload is running without its MCP endpoint:[^\n]*/)?.[0])} (once)`,
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // A non-loopback address: a wildcard bind is refused, not served.
  {
    const { scratch, userData, env: base } = proofScratch();
    const env = withFakeMcp(base, scratch, anytype.url);
    try {
      const degraded = /notice: Reload is running without its MCP endpoint:/g;
      const { log, endpoint } = await runUntil(
        { ...env, RELOAD_MCP_HOST: "0.0.0.0" },
        userData,
        degraded,
      );
      expect(count(log, degraded)).toBe(1);
      expect(endpoint.problem).toContain("loopback");
      lines.push(
        `non-loopback 0.0.0.0: ${String(log.match(/notice: Reload is running without its MCP endpoint:[^\n]*/)?.[0])} (once)`,
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  await anytype.close();
  evidence("refusal-notices", lines);
});
