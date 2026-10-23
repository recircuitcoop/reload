// Reload from a terminal (plan 0031 group E): a second process started with `--status` or
// `--quit` asks the running instance with a question file in its user-data folder, never the
// single-instance lock, prints its answer and exits; with none running, or none answering,
// `--status` answers from the files and `--quit` says so and exits 1. `--log` and
// `--quit --force` ask nobody.
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
    const nothing = "Nothing is running.\nNothing was refused, and nothing is held back.\n";
    expect(await reload("--status", env)).toEqual({ code: 0, stdout: nothing });
    // The log is named with nothing running, before anything was written to it.
    const unwritten = await reload("--log", env);
    expect(unwritten.code).toBe(0);
    expect(unwritten.stdout).toMatch(/^Log file: .+reload\.log\n {2}nothing written yet: /);
    const logFile = /^Log file: (.+)$/m.exec(unwritten.stdout)?.[1] ?? "";
    expect(logFile.startsWith(scratch)).toBe(true);

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
    expect(log.stdout.startsWith(`Log file: ${logFile}\n`)).toBe(true);
    expect(log.stdout).toContain("answering `reload --status` from a terminal");

    // Plain --quit names what it watched stop, so it needs the run-state to have recorded it.
    const runState = path.join(userData, "run-state.json");
    await expect
      .poll(() => (fs.existsSync(runState) ? fs.readFileSync(runState, "utf8") : ""))
      .toContain(`"pid":${String(runtime.pid)}`);
    const exited = exitOf(app);
    const quit = await reload("--quit", env);
    expect(quit.code).toBe(0);
    expect(quit.stdout.endsWith("Reload is off.\n")).toBe(true);
    expect(quit.stdout).toContain(`  runtime stopped (process ${String(runtime.pid)})`);
    expect(quit.stdout).toContain(`  shell stopped (process ${String(shellPid)})`);
    expect(await exited).toBe(0);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    expect(fs.existsSync(runState)).toBe(false);
    // Started from a terminal, it said there what it came up without, and still exited 0.
    expect(output.join("")).toContain("Reload starts without it");

    expect(await reload("--quit", env)).toEqual({ code: 1, stdout: "Reload is not running.\n" });
    expect(await reload("--status", env)).toEqual({ code: 0, stdout: nothing });
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a command whose reader closed ends with its own exit code, never a hang", async () => {
  const { scratch, env } = scratchDirectories();
  try {
    // `reload --status | grep -q …`: the reader is gone before anything is written.
    const closed = (flag: string) =>
      new Promise<number | null>((resolve, reject) => {
        const second = spawn(ELECTRON_BINARY, [APP, flag], {
          env,
          stdio: ["ignore", "pipe", "ignore"],
        });
        second.stdout.destroy();
        second.once("error", reject);
        second.once("close", resolve);
      });
    expect(await closed("--status")).toBe(0);
    expect(await closed("--log")).toBe(0);
    expect(await closed("--quit")).toBe(1);
  } finally {
    await cleanUp([], scratch);
  }
});

test("a stopped Reload survives reload --status and --quit, which say it did not answer", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await waitForRunning(window, "runtime");
    const shellPid = await app.evaluate(() => process.pid);
    const runState = path.join(userData, "run-state.json");
    await expect
      .poll(() => (fs.existsSync(runState) ? fs.readFileSync(runState, "utf8") : ""))
      .toContain(`"pid":${String(shellPid)}`);
    // Stopped, it can answer nothing: asking must neither wait on it for long nor kill it.
    process.kill(shellPid, "SIGSTOP");
    try {
      const status = await reload("--status", env);
      expect(status.code).toBe(0);
      expect(status.stdout.startsWith("Reload did not answer within 5 seconds.\n")).toBe(true);
      expect(status.stdout).toContain(`  shell: running (process ${String(shellPid)})\n`);
      expect(await reload("--quit", env)).toEqual({
        code: 1,
        stdout: "Reload did not answer within 5 seconds.\n",
      });
    } finally {
      process.kill(shellPid, "SIGCONT");
    }
    // Woken, it is still the same Reload: it never acts on the questions it did not take, and
    // answers the next one.
    expect(isAlive(shellPid)).toBe(true);
    const again = await reload("--status", env);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(
      new RegExp(`^Reload \\S+ is running \\(process ${String(shellPid)}\\)\\.\\n`),
    );
    expect(isAlive(shellPid)).toBe(true);
    expect(fs.readdirSync(userData).filter((name) => name.startsWith("command-"))).toEqual([]);
    const exited = exitOf(app);
    expect((await reload("--quit", env)).code).toBe(0);
    expect(await exited).toBe(0);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a --quit interrupted or killed while Reload could not answer is never acted on once it can", async () => {
  test.setTimeout(120_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  const questions = () => fs.readdirSync(userData).filter((name) => name.startsWith("command-"));
  try {
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    await waitForRunning(window, "runtime");
    const shellPid = await app.evaluate(() => process.pid);
    const runState = path.join(userData, "run-state.json");
    await expect
      .poll(() => (fs.existsSync(runState) ? fs.readFileSync(runState, "utf8") : ""))
      .toContain(`"pid":${String(shellPid)}`);
    for (const signal of ["SIGINT", "SIGKILL"] as const) {
      process.kill(shellPid, "SIGSTOP");
      try {
        const asker = spawn(ELECTRON_BINARY, [APP, "--quit"], { env, stdio: "ignore" });
        const ended = new Promise((resolve) => asker.once("close", resolve));
        // Its question is waiting for a Reload that cannot take it; then the asker is stopped.
        await expect.poll(questions, { timeout: 20_000 }).toHaveLength(1);
        const signalled = Date.now();
        asker.kill(signal);
        await ended;
        expect(Date.now() - signalled).toBeLessThan(2_000);
      } finally {
        process.kill(shellPid, "SIGCONT");
      }
      // Awake, it takes the question, finds its asker gone, and leaves it unanswered.
      await expect
        .poll(() => output.join("").split("left `reload --quit` unanswered: its asker is gone"), {
          timeout: 20_000,
        })
        .toHaveLength(signal === "SIGINT" ? 2 : 3);
      expect(questions()).toEqual([]);
      expect(isAlive(shellPid)).toBe(true);
    }
    expect(output.join("")).not.toContain("answering `reload --quit` from a terminal");
    const exited = exitOf(app);
    expect((await reload("--quit", env)).code).toBe(0);
    expect(await exited).toBe(0);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("reload --quit --force stops every recorded process of a stopped Reload itself, asking nobody", async () => {
  // The shell is given its polite stop before it is killed.
  test.setTimeout(120_000);
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

    // Stopped, it cannot answer anything: the forced quit asks it nothing.
    process.kill(shellPid, "SIGSTOP");
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
