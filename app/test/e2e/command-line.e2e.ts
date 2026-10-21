// Reload from a terminal (plan 0031 group E): a second process started with `--status`, `--log`
// or `--quit` asks the running instance over the single-instance channel, prints its answer and
// exits; with none running it says so and exits 1. `--quit --force` asks nobody.
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  APP,
  cleanUp,
  ELECTRON_BINARY,
  exitOf,
  isAlive,
  launchApp,
  processesNaming,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

/** `reload <flag>` as a second process with the run's environment: its exit and its output. */
function reload(
  flag: string | readonly string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const second = spawn(ELECTRON_BINARY, [APP, ...(typeof flag === "string" ? [flag] : flag)], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    second.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    second.once("error", reject);
    second.once("close", (code) => {
      resolve({ code, stdout });
    });
  });
}

test("reload --status and --quit act on the running instance from a second process", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    expect(await reload("--status", env)).toEqual({
      code: 1,
      stdout: "Reload is not running.\n",
    });

    const { app, window, output } = await launchApp(env);
    apps.push(app);
    const runtime = await waitForRunning(window, "runtime");
    await waitForRunning(window, "services");
    const shellPid = await app.evaluate(() => process.pid);

    const status = await reload("--status", env);
    expect(status.code).toBe(0);
    const lines = status.stdout.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^Reload \\S+ is running \\(process ${String(shellPid)}\\)\\.$`),
    );
    expect(lines[1]).toBe(`  runtime: running (process ${String(runtime.pid)})`);
    expect(lines[2]).toMatch(/^ {2}services: running \(process \d+\)$/);
    expect(lines[3]).toMatch(/^ {2}Anytype: /);
    // A second launch with a command never brings the window forward.
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    ).toBe(false);

    const log = await reload("--log", env);
    expect(log.code).toBe(0);
    expect(log.stdout).toMatch(/^Log file: .+\n {2}\d+ bytes; the last lines:\n/);
    expect(log.stdout).toContain("answering `reload --status` from a second launch");

    const exited = exitOf(app);
    const quit = await reload("--quit", env);
    expect(quit.code).toBe(0);
    expect(quit.stdout.endsWith("Reload is off.\n")).toBe(true);
    expect(quit.stdout).toContain(`  runtime stopped (process ${String(runtime.pid)})`);
    expect(await exited).toBe(0);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    // Started from a terminal, it said there what it came up without, and still exited 0.
    expect(output.join("")).toContain("Reload starts without it");

    expect(await reload("--quit", env)).toEqual({ code: 1, stdout: "Reload is not running.\n" });
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("reload --quit --force stops every recorded process itself, without asking the app", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    const runtime = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const shellPid = await app.evaluate(() => process.pid);
    // The run-state names the shell and both children once they run.
    const recorded = () =>
      (
        JSON.parse(fs.readFileSync(path.join(userData, "run-state.json"), "utf8")) as {
          id: string;
          pid: number;
        }[]
      ).map((record) => `${record.id} ${String(record.pid)}`);
    await expect
      .poll(() => (fs.existsSync(path.join(userData, "run-state.json")) ? recorded() : []))
      .toEqual([
        `shell ${String(shellPid)}`,
        `runtime ${String(runtime.pid)}`,
        `services ${String(services.pid)}`,
      ]);

    const exited = exitOf(app);
    const forced = await reload(["--quit", "--force"], env);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toMatch(
      new RegExp(`^ {2}shell (terminated|killed) \\(process ${String(shellPid)}\\)\\n`),
    );
    expect(forced.stdout).toContain(`(process ${String(runtime.pid)})`);
    expect(forced.stdout.endsWith("Reload is off.\n")).toBe(true);
    await exited;
    expect(isAlive(runtime.pid)).toBe(false);
    expect(isAlive(services.pid)).toBe(false);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    expect(fs.existsSync(path.join(userData, "run-state.json"))).toBe(false);
  } finally {
    await cleanUp(apps, scratch);
  }
});
