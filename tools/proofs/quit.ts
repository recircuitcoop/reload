// proof quit (plan 0018 §5.4): Quit leaves no process; kill -9 of the shell leaves none;
// closing the window does not quit. Against the packaged app (harness.ts).
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { isAlive, processesNaming, waitForRunning } from "../../app/test/e2e/app-harness";
import {
  evidence,
  proofScratch,
  quitFromCommandLine,
  startPackaged,
  stopRun,
  type PackagedRun,
} from "./harness";

test("Quit leaves no process; kill -9 of the shell leaves none; closing the window does not quit", async () => {
  const { scratch, userData, env } = proofScratch();
  let run: PackagedRun | null = null;
  try {
    // Closing the window is not quitting: the window goes, the shell and its children stay.
    run = await startPackaged(env);
    const runtime = await waitForRunning(run.page, "runtime");
    const services = await waitForRunning(run.page, "services");
    await run.page.evaluate(() => {
      window.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(run.shell.exitCode).toBeNull();
    expect(isAlive(runtime.pid)).toBe(true);
    expect(isAlive(services.pid)).toBe(true);

    // Quit, as `reload --quit` asks the running instance: every process gone.
    expect(await quitFromCommandLine(run, env)).toBe(0);
    expect(await run.exited).toBe(0);
    const quitLog = run.output.join("");
    expect(quitLog).toContain("quit complete");
    await expect.poll(() => processesNaming(userData), { timeout: 15_000 }).toEqual([]);
    expect(isAlive(runtime.pid)).toBe(false);
    expect(isAlive(services.pid)).toBe(false);
    evidence("quit", [
      `window closed: shell ${String(run.shell.pid)}, runtime ${String(runtime.pid)} and services ${String(services.pid)} still running`,
      `reload --quit: shell exited 0, "quit complete" logged, no process names ${userData}`,
    ]);
    await run.browser.close().catch(() => undefined);

    // kill -9 of the shell: its children go with it.
    run = await startPackaged(env);
    const runtime2 = await waitForRunning(run.page, "runtime");
    const services2 = await waitForRunning(run.page, "services");
    run.shell.kill("SIGKILL");
    await run.exited;
    await expect.poll(() => processesNaming(userData), { timeout: 15_000 }).toEqual([]);
    expect(isAlive(runtime2.pid)).toBe(false);
    expect(isAlive(services2.pid)).toBe(false);
    evidence("quit", [
      `kill -9 of shell ${String(run.shell.pid)}: runtime ${String(runtime2.pid)} and services ${String(services2.pid)} gone, no process names ${userData}`,
    ]);
    await run.browser.close().catch(() => undefined);
    run = null;
  } finally {
    await stopRun(run, userData);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
