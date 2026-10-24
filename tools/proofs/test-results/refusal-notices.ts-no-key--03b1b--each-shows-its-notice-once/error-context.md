# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: refusal-notices.ts >> no key, Anytype not running, port taken, non-loopback address: each shows its notice once
- Location: ../tools/proofs/refusal-notices.ts:53:1

# Error details

```
Error: ENOENT: no such file or directory, open '/private/var/folders/k_/2kvt0lj50cn68wdj6jdw253h0000gn/T/reload-e2e-brt3cs/user-data/notices.json'
```

# Test source

```ts
  1   | // proof refusal-notices (plan 0018 §5.4): no key, Anytype not running, port taken, a
  2   | // non-loopback address: each shows its notice once. Against the packaged app (harness.ts).
  3   | //
  4   | // "Shows" is what the shell's NoticeBoard does: the notice is logged as `notice: <title>: <body>`
  5   | // once as it is handed to the desktop, and written to notices.json before that. No key is not a
  6   | // desktop notice in this app: it is the Anytype state the window shows (Settings says Not
  7   | // paired yet.), logged once; this proof holds it to that.
  8   | import fs from "node:fs";
  9   | import net from "node:net";
  10  | import * as path from "node:path";
  11  | import { expect, test } from "@playwright/test";
  12  | import { anytypeKeyFile, processesNaming } from "../../app/test/e2e/app-harness";
  13  | import {
  14  |   appCall,
  15  |   evidence,
  16  |   proofScratch,
  17  |   quitFromCommandLine,
  18  |   startPackaged,
  19  |   stopRun,
  20  |   type PackagedRun,
  21  | } from "./harness";
  22  | 
  23  | /** How long a run is watched after its notice, for a second one that must not come. */
  24  | const SETTLE_MS = 15_000;
  25  | 
  26  | const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
  27  | 
  28  | /** Start, wait for `pattern` in the log, watch for a repeat, quit; the run's log. */
  29  | async function runUntil(env: Record<string, string>, userData: string, pattern: RegExp) {
  30  |   let run: PackagedRun | null = null;
  31  |   try {
  32  |     run = await startPackaged(env);
  33  |     const said = () => run?.output.join("") ?? "";
  34  |     await expect.poll(() => count(said(), pattern), { timeout: 60_000 }).toBeGreaterThan(0);
  35  |     // Asked again, as Check again and coming back to Reload ask: still the one notice.
  36  |     await appCall(run.page, "checkAnytype");
  37  |     await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  38  |     const anytype = (await appCall(run.page, "anytypeStatus")) as { state: string };
  39  |     const endpoint = (await appCall(run.page, "mcpEndpoint")) as { problem: string | null };
> 40  |     const notices = fs.readFileSync(path.join(userData, "notices.json"), "utf8");
      |                        ^ Error: ENOENT: no such file or directory, open '/private/var/folders/k_/2kvt0lj50cn68wdj6jdw253h0000gn/T/reload-e2e-brt3cs/user-data/notices.json'
  41  |     expect(await quitFromCommandLine(env)).toBe(0);
  42  |     await run.exited;
  43  |     await expect.poll(() => processesNaming(userData), { timeout: 15_000 }).toEqual([]);
  44  |     await run.browser.close().catch(() => undefined);
  45  |     const log = said();
  46  |     run = null;
  47  |     return { log, anytype, endpoint, notices };
  48  |   } finally {
  49  |     await stopRun(run, userData);
  50  |   }
  51  | }
  52  | 
  53  | test("no key, Anytype not running, port taken, non-loopback address: each shows its notice once", async () => {
  54  |   const lines: string[] = [];
  55  | 
  56  |   // No key: the Anytype state no-key, said once, and no desktop notice about Anytype.
  57  |   {
  58  |     const { scratch, userData, env } = proofScratch();
  59  |     try {
  60  |       fs.rmSync(anytypeKeyFile(scratch));
  61  |       const noKey = /anytype: no-key \(no Anytype API key in /g;
  62  |       const { log, anytype } = await runUntil(env, userData, noKey);
  63  |       expect(count(log, noKey)).toBe(1);
  64  |       expect(anytype.state).toBe("no-key");
  65  |       expect(log).not.toMatch(/notice: Reload cannot reach Anytype/);
  66  |       lines.push(`no key: state ${anytype.state}, logged once: ${String(log.match(/anytype: no-key[^\n]*/)?.[0])}`);
  67  |     } finally {
  68  |       fs.rmSync(scratch, { recursive: true, force: true });
  69  |     }
  70  |   }
  71  | 
  72  |   // Anytype not running: a key, and nothing answering at Anytype's address.
  73  |   {
  74  |     const { scratch, userData, env } = proofScratch();
  75  |     try {
  76  |       const unreachable = /notice: Reload cannot reach Anytype:/g;
  77  |       const { log, anytype, notices } = await runUntil(env, userData, unreachable);
  78  |       expect(count(log, unreachable)).toBe(1);
  79  |       expect(anytype.state).toBe("unreachable");
  80  |       expect(notices).toContain("anytype-unreachable");
  81  |       lines.push(`Anytype not running: ${String(log.match(/notice: Reload cannot reach Anytype:[^\n]*/)?.[0])} (once; notices.json has anytype-unreachable)`);
  82  |     } finally {
  83  |       fs.rmSync(scratch, { recursive: true, force: true });
  84  |     }
  85  |   }
  86  | 
  87  |   // Port taken: something else holds the MCP port before Reload starts.
  88  |   {
  89  |     const { scratch, userData, env } = proofScratch();
  90  |     const blocker = net.createServer();
  91  |     try {
  92  |       await new Promise<void>((resolve) => blocker.listen(Number(env["RELOAD_MCP_PORT"]), "127.0.0.1", resolve));
  93  |       const degraded = /notice: Reload is running without its MCP endpoint:/g;
  94  |       const { log, endpoint, notices } = await runUntil(env, userData, degraded);
  95  |       expect(count(log, degraded)).toBe(1);
  96  |       expect(endpoint.problem).toContain(env["RELOAD_MCP_PORT"]);
  97  |       expect(notices).toContain("endpoint-degraded");
  98  |       lines.push(`port taken: ${String(log.match(/notice: Reload is running without its MCP endpoint:[^\n]*/)?.[0])} (once)`);
  99  |     } finally {
  100 |       await new Promise((resolve) => blocker.close(resolve));
  101 |       fs.rmSync(scratch, { recursive: true, force: true });
  102 |     }
  103 |   }
  104 | 
  105 |   // A non-loopback address: a wildcard bind is refused, not served.
  106 |   {
  107 |     const { scratch, userData, env } = proofScratch();
  108 |     try {
  109 |       const degraded = /notice: Reload is running without its MCP endpoint:/g;
  110 |       const { log, endpoint } = await runUntil({ ...env, RELOAD_MCP_HOST: "0.0.0.0" }, userData, degraded);
  111 |       expect(count(log, degraded)).toBe(1);
  112 |       expect(endpoint.problem).toContain("loopback");
  113 |       lines.push(`non-loopback 0.0.0.0: ${String(log.match(/notice: Reload is running without its MCP endpoint:[^\n]*/)?.[0])} (once)`);
  114 |     } finally {
  115 |       fs.rmSync(scratch, { recursive: true, force: true });
  116 |     }
  117 |   }
  118 | 
  119 |   evidence("refusal-notices", lines);
  120 | });
  121 | 
```