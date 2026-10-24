// proof log (plan 0018 §5.4): the log file is at the documented path with lines from the shell,
// the runtime, the services, a node and the MCP child; canary secrets are redacted; it rotates.
// Against the packaged app (harness.ts), with the repo's fake MCP child in its canary mode (it
// prints the key it was given, as a careless server would) and a first-party node running.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { defaultLogPath, MAX_LOG_BYTES } from "../../app/src/adapters/fs/log-writer";
import { processesNaming, waitForRunning } from "../../app/test/e2e/app-harness";
import { request } from "../../app/test/e2e/probe-flow";
import {
  appCall,
  evidence,
  evidenceFile,
  fakeAnytype,
  proofScratch,
  quitFromCommandLine,
  startPackaged,
  stopRun,
  withFakeMcp,
  type PackagedRun,
} from "./harness";

/**
 * The folder watcher's lines: a healthy watcher writes no line of its own, so its lines are its
 * frames as the runtime logs them, under its type and instance (node-process.ts): it was
 * spawned, it is ready, and the event it emitted for the file this proof drops in.
 */
const NODE_LINE = /\[reload-reload_folder-watch w1\] event emitted: [^\n]*/;

const CANARY = "proof-log-canary-that-must-never-be-written-24680";

test("the log file is at the documented path with lines from shell, runtime, services, a node and the MCP child; canary secrets are redacted; it rotates", async () => {
  const { scratch, userData, env: base, canaryKey } = proofScratch();
  const anytype = await fakeAnytype();
  const env = { ...withFakeMcp(base, scratch, anytype.url, "canary"), RELOAD_LOG_CANARY: CANARY };
  const file = defaultLogPath({ platform: process.platform, home: scratch, env });
  // A log just short of its bound, as months of use leave it: this run's lines must rotate it.
  const seed = "an earlier run's line\n".repeat(Math.floor((MAX_LOG_BYTES - 4096) / 22));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, seed);
  const inbox = path.join(scratch, "inbox");
  fs.mkdirSync(inbox);
  let run: PackagedRun | null = null;
  try {
    run = await startPackaged(env);
    const page = run.page;
    const runtime = await waitForRunning(page, "runtime");
    const services = await waitForRunning(page, "services");
    await expect
      .poll(async () => ((await appCall(page, "anytypeStatus")) as { state: string }).state, {
        timeout: 60_000,
      })
      .toBe("ready");
    const mcpPid = ((await appCall(page, "anytypeStatus")) as { childPid: number }).childPid;
    // A node: the shipped folder watcher, deployed the way the editor deploys.
    const flow = [
      { id: "proof-log", type: "tab", label: "Proof log" },
      { id: "w1", type: "reload-reload_folder-watch", z: "proof-log", folder: inbox, wires: [[]] },
    ];
    expect(await request(Number(runtime.port), "/red/flows", flow)).toBe(204);
    // A file dropped in once it watches (files there at its first scan are never passed on).
    await expect
      .poll(() => run?.output.join("").includes("[reload-reload_folder-watch w1] ready"), {
        timeout: 60_000,
      })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    fs.writeFileSync(path.join(inbox, "a.txt"), "a file for the folder watcher\n");
    await expect
      .poll(() => run?.output.join("").match(NODE_LINE)?.[0] ?? null, { timeout: 60_000 })
      .not.toBeNull();
    expect(await quitFromCommandLine(run, env)).toBe(0);
    await run.exited;
    await expect.poll(() => processesNaming(userData), { timeout: 15_000 }).toEqual([]);
    await run.browser.close().catch(() => undefined);
    run = null;

    // The documented path, under the scratch home; the earlier lines rotated to .1.
    expect(file.startsWith(scratch)).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["reload.log", "reload.log.1"]);
    const rotated = fs.readFileSync(`${file}.1`, "utf8");
    expect(rotated.startsWith(seed)).toBe(true);
    const current = fs.readFileSync(file, "utf8");
    expect(current).not.toContain("an earlier run's line");
    // This run's lines: those it wrote before the rotation, then the file it rotated to.
    const text = rotated.slice(seed.length) + current;
    // The files themselves are the evidence (scratch paths and canaries only).
    evidenceFile("log-reload.log", current);
    evidenceFile("log-reload.log.1-this-run.log", rotated.slice(seed.length));

    const pidOf = (line: string) => line.split(/\s+/)[3];
    const from = (name: string) => text.split("\n").filter((line) => line.includes(` ${name}: `));
    const shellLines = from("reload.shell");
    const shellPid = pidOf(shellLines[0] ?? "");
    expect(shellLines.length).toBeGreaterThan(0);
    expect(from("reload.runtime").some((line) => pidOf(line) === String(runtime.pid))).toBe(true);
    expect(from("reload.services").some((line) => pidOf(line) === String(services.pid))).toBe(true);
    const nodeLines = text
      .split("\n")
      .filter((line) => line.includes("[reload-reload_folder-watch w1]"));
    expect(nodeLines.some((line) => NODE_LINE.test(line))).toBe(true);
    expect(nodeLines.length).toBeGreaterThan(0);
    const mcpLines = text
      .split("\n")
      .filter((line) => /fake MCP child \d+ running on stdio/.test(line));
    expect(mcpLines.length).toBeGreaterThan(0);

    // Both canaries reached the logger and neither reached the file.
    expect(text).toContain("log canary: [redacted]");
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(canaryKey);
    evidence("log", [
      `file ${file.replace(scratch, "$HOME")}; rotated: reload.log.1 holds the seeded ${String(seed.length)} bytes`,
      `shell pid ${String(shellPid)}: ${String(shellLines.length)} lines; runtime pid ${String(runtime.pid)}; services pid ${String(services.pid)}`,
      `node (reload_folder watch, instance w1): ${String(nodeLines.length)} lines, e.g. ${String(nodeLines[0]).slice(0, 200)}`,
      `MCP child pid ${String(mcpPid)}: ${String(mcpLines[0]).slice(0, 160)}`,
      "RELOAD_LOG_CANARY and the canary Anytype key the fake MCP child printed: neither in the file; [redacted] in their place",
    ]);
  } finally {
    await stopRun(run, userData);
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
