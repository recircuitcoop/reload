// Reload started as a person starts it, without the watcher (plan 0032 group 11): the shell
// hands its start over to the watcher and quits, and the watcher relaunches the real shell after
// a crash, but never after a kill or a quit. Every other spec starts the shell as if the watcher
// had (app-harness.ts launchTracked), since Playwright must hold the process it launched.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { QUIT_FILENAME, UNDER_WATCHER_VARIABLE } from "../../src/domain/supervision/relaunch";
import { E2E_CRASH_FILENAME } from "../../src/shell/e2e-hooks";
import { APP, ELECTRON_BINARY, isAlive, processesNaming, scratchDirectories } from "./app-harness";

/** The parent of a live pid, as the process table says. */
const parentOf = (pid: number): number =>
  Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());

/** Reload as a person starts it, or a terminal command; answers its exit code. */
function reload(args: readonly string[], env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // Its stderr is the watcher's too, which inherits it: what the watcher says arrives here.
    const started = spawn(ELECTRON_BINARY, [APP, ...args], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    started.stderr.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    started.once("error", reject);
    started.once("exit", resolve);
  });
}

/** Everything Reload and its watcher wrote to the terminal, as these starts saw it. */
const said: string[] = [];
/** The lines the watcher said about a crash it relaunched. */
const relaunches = (): string[] =>
  said.join("").match(/reload: Reload crashed \([^)]+\); starting it again in \d+ ms/g) ?? [];

test("Reload hands its start to the watcher, which relaunches a real crash and never a kill or a quit", async () => {
  test.setTimeout(180_000);
  const { scratch, userData, env } = scratchDirectories();
  const unwatched = {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => name !== UNDER_WATCHER_VARIABLE)),
    // For the one-shot real crashes (shell/e2e-hooks.ts crashOnceForE2e).
    RELOAD_E2E_HOOKS: "1",
  };
  const crashNext = (how: "crash" | "oom") => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, E2E_CRASH_FILENAME), how);
  };
  const runState = path.join(userData, "run-state.json");
  /** The shell the run-state file names, once one runs with its runtime. */
  const recordedShell = (): number | null => {
    try {
      const records = JSON.parse(fs.readFileSync(runState, "utf8")) as {
        id: string;
        pid: number;
      }[];
      const shell = records.find((record) => record.id === "shell")?.pid ?? null;
      return records.some((record) => record.id === "runtime") ? shell : null;
    } catch {
      return null; // not written yet, or being replaced
    }
  };
  const seen = new Set<number>();
  const started = async (): Promise<{ shell: number; watcher: number }> => {
    let shell: number | null = null;
    await expect
      .poll(
        () => {
          shell = recordedShell();
          return shell !== null && !seen.has(shell) && isAlive(shell);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const pid = shell as unknown as number;
    seen.add(pid);
    seen.add(parentOf(pid));
    return { shell: pid, watcher: parentOf(pid) };
  };
  try {
    // The start a person makes, its first shell crashing for real (process.crash()): the
    // process started quits at once, having handed over, and the watcher starts the shell again.
    crashNext("crash");
    expect(await reload([], unwatched)).toBe(0);
    const first = await started();
    // The watcher is its own process, the shell's parent, never this test.
    expect(first.watcher).not.toBe(process.pid);
    expect(isAlive(first.watcher)).toBe(true);
    expect(relaunches()).toEqual([
      expect.stringMatching(/crashed \(SIG[A-Z]+\); starting it again in 1000 ms/),
    ]);
    expect(fs.existsSync(path.join(userData, E2E_CRASH_FILENAME))).toBe(false);

    // A kill: nothing is relaunched, because the watcher itself ends.
    process.kill(first.shell, "SIGKILL");
    await expect.poll(() => isAlive(first.watcher), { timeout: 20_000 }).toBe(false);
    await expect.poll(() => processesNaming(userData), { timeout: 20_000 }).toEqual([]);
    expect(relaunches()).toHaveLength(1);
    fs.rmSync(runState, { force: true });

    // A V8 heap out of memory in the shell, the crash a leak ends in: relaunched too.
    crashNext("oom");
    expect(await reload([], unwatched)).toBe(0);
    const again = await started();
    expect(again.watcher).not.toBe(first.watcher);
    expect(relaunches()).toHaveLength(2);
    expect(relaunches()[1]).toMatch(/crashed \(SIG[A-Z]+\)/);

    // A quit (`reload --quit`): the shell quits, and the watcher with it.
    // A second start while it runs is answered by the running one: no second watcher.
    expect(await reload([], unwatched)).toBe(0);
    // `reload --status` is answered by the shell under the watcher, as by any shell.
    expect(await reload(["--status"], unwatched)).toBe(0);
    expect(await reload(["--quit"], unwatched)).toBe(0);
    await expect.poll(() => isAlive(again.shell), { timeout: 30_000 }).toBe(false);
    await expect.poll(() => isAlive(again.watcher), { timeout: 10_000 }).toBe(false);
    expect(fs.existsSync(runState)).toBe(false);
    // The quit the shell recorded for the watcher went with it.
    expect(fs.existsSync(path.join(userData, QUIT_FILENAME))).toBe(false);
    expect(relaunches()).toHaveLength(2);
    await expect.poll(() => processesNaming(userData), { timeout: 20_000 }).toEqual([]);
  } finally {
    // Only this run's own processes, by pid.
    const ours = (pid: number): boolean => {
      try {
        const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
        });
        return command.includes(ELECTRON_BINARY);
      } catch {
        return false; // gone
      }
    };
    for (const pid of seen) {
      if (ours(pid)) process.kill(pid, "SIGKILL");
    }
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
