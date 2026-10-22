// The Anytype desktop app against the real process table (WI-0018-21), with a fake app binary
// in a scratch directory: started if absent, adopted if running, quit only if Reload started
// it. Nothing here can reach this user's Anytype: the only executable named is the fake's.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessTableApps } from "../../src/adapters/process/desktop-apps";
import { AnytypeApp } from "../../src/application/anytype-app";
import { fakeAnytypeApp, fakeAnytypePid, isAlive, ORPHAN_EXIT } from "../fakes/anytype-app";
import { RecordingLogger } from "../fakes/children";

/** Every fake a test wrote: each one's pid is killed afterwards, whatever the test did. */
const fakes: string[] = [];

afterEach(() => {
  for (const executable of fakes.splice(0)) {
    const pid = fakeAnytypePid(executable);
    if (pid !== null && isAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
});

async function until<T>(what: string, probe: () => T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function scratchApp(): string {
  const executable = fakeAnytypeApp(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-reload_anytype-"))),
  );
  fakes.push(executable);
  return executable;
}

describe("ProcessTableApps and AnytypeApp, with a fake Anytype", () => {
  it("starts it when absent, finds it by its path, and quits it on Quit because it started it", async () => {
    const executable = scratchApp();
    const apps = new ProcessTableApps(process.platform);
    expect(await apps.find(executable)).toBeNull();

    const anytype = new AnytypeApp({ apps, executable, logger: new RecordingLogger() });
    expect(await anytype.start()).toBe("started");
    const pid = await until("the fake Anytype to run", () => fakeAnytypePid(executable));
    expect(await apps.find(executable)).toEqual({ pid });

    await anytype.quitIfOurs();
    expect(isAlive(pid)).toBe(false);
    expect(await apps.find(executable)).toBeNull();
  }, 30_000);

  it("adopts one already running, starts no second, and leaves it running on Quit", async () => {
    const executable = scratchApp();
    const theirs = spawn(executable, [], { detached: true, stdio: "ignore" });
    theirs.unref();
    const pid = await until("the running Anytype", () => fakeAnytypePid(executable));

    const logger = new RecordingLogger();
    const apps = new ProcessTableApps(process.platform);
    const anytype = new AnytypeApp({ apps, executable, logger });
    expect(await anytype.start()).toBe("adopted");
    await anytype.quitIfOurs();
    expect(isAlive(pid)).toBe(true);
    expect(await apps.find(executable)).toEqual({ pid });
    expect(logger.lines.join("\n")).toContain(`already running as process ${String(pid)}`);
  }, 30_000);

  it("a quit ends an app that ignores SIGTERM, after the grace period", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-reload_anytype-")));
    const executable = path.join(dir, "stubborn-anytype");
    fs.writeFileSync(
      executable,
      `#!/bin/bash\nexec -a "$0" ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `process.on('SIGTERM', () => undefined); require('fs').writeFileSync(process.argv[1], String(process.pid)); ${ORPHAN_EXIT}`,
      )} "$0.pid"\n`,
      { mode: 0o755 },
    );
    fakes.push(executable);
    const app = new ProcessTableApps(process.platform).launch(executable);
    const pid = await until("the stubborn Anytype", () => fakeAnytypePid(executable));
    const began = Date.now();
    await app.quit();
    expect(isAlive(pid)).toBe(false);
    expect(Date.now() - began).toBeGreaterThanOrEqual(9_000);
    // A second quit of one already gone answers at once.
    await app.quit();
  }, 30_000);

  it("the fake ends itself once whoever started it is gone, so a failed test leaves no process", async () => {
    const executable = scratchApp();
    // A shell that starts the fake and exits a second later, leaving it orphaned.
    spawn("/bin/sh", ["-c", `${JSON.stringify(executable)} >/dev/null 2>&1 & sleep 1`], {
      stdio: "ignore",
    });
    const pid = await until("the orphaned fake to run", () => fakeAnytypePid(executable));
    await until("the orphan to end itself", () => (isAlive(pid) ? null : true), 5_000);
  }, 30_000);

  it("a launcher that cannot be started is an error, never a crash of the caller", () => {
    const apps = new ProcessTableApps(process.platform);
    expect(() => apps.launch(path.join(os.tmpdir(), "no-such-anytype-here"))).toThrow(
      /could not be started/,
    );
  });
});
