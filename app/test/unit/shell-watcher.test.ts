// The watcher (plan 0032 group 11; the old host's HelperWatch, test_helper_launcher.py): the
// shell's parent, which relaunches a crashed shell and nothing else.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { handOffToWatcher, watcherNode } from "../../src/adapters/process/watcher-handoff";
import {
  shellEnding,
  UNDER_WATCHER_VARIABLE,
  type WatcherConfig,
} from "../../src/domain/supervision/relaunch";
import { DEFAULT_STABILITY } from "../../src/domain/supervision/stability";
import { watchShell, type WatchedShell } from "../../src/shell/watcher";
import { FakeClock } from "../fakes/clock";

const CONFIG: WatcherConfig = {
  command: "/Applications/Reload.app/Contents/MacOS/Reload",
  args: ["--hidden"],
  env: { HOME: "/home/test", [UNDER_WATCHER_VARIABLE]: "1" },
  delaysMs: DEFAULT_STABILITY.backoff.delaysMs,
  crashLoop: { maxCrashes: 5, windowMs: 120_000 },
};

/** A watcher over fake shells: each start recorded, each ended by the test. */
function watched(config: WatcherConfig = CONFIG) {
  const clock = new FakeClock();
  const starts: WatcherConfig[] = [];
  const shells: ((code: number | null, signal: string | null) => void)[] = [];
  const said: string[] = [];
  let exits = 0;
  watchShell(config, {
    start: (given): WatchedShell => {
      starts.push(given);
      return {
        onExit: (listener) => {
          shells.push(listener);
        },
      };
    },
    after: (ms, run) => {
      clock.after(ms, run);
    },
    now: () => clock.now(),
    say: (line) => said.push(line),
    exit: () => {
      exits += 1;
    },
  });
  const end = (code: number | null, signal: string | null = null) => {
    shells.at(-1)?.(code, signal);
  };
  return { clock, starts, said, end, exits: () => exits };
}

describe("the watcher", () => {
  it("starts the shell once, as it was started, with the marker set", () => {
    const { starts } = watched();
    expect(starts).toEqual([CONFIG]);
  });

  // test_the_host_relaunches_a_crashed_helper[ending0..4]: a non-zero exit and a crash signal.
  for (const [code, signal] of [
    [1, null],
    [134, null],
    [null, "SIGSEGV"],
    [null, "SIGABRT"],
    [null, "SIGBUS"],
  ] as const) {
    it(`relaunches a shell that crashed (${signal ?? `exit code ${String(code)}`}) when its delay has run out`, () => {
      const { clock, starts, said, end, exits } = watched();
      end(code, signal);
      // Scheduled, not slept through: the relaunch happens when the first delay runs out.
      clock.advance(999);
      expect(starts).toHaveLength(1);
      clock.advance(1);
      expect(starts).toHaveLength(2);
      expect(starts[1]).toEqual(CONFIG);
      expect(exits()).toBe(0);
      expect(said).toEqual([
        `reload: Reload crashed (${signal ?? `exit code ${String(code)}`}); starting it again in 1000 ms`,
      ]);
    });
  }

  // test_the_host_never_relaunches_a_helper_it_did_not_see_crash: a kill and a quit.
  for (const [code, signal] of [
    [null, "SIGTERM"],
    [null, "SIGINT"],
    [null, "SIGKILL"],
    [0, null],
    [null, null],
  ] as const) {
    it(`never relaunches a shell that was stopped or quit (${signal ?? `exit code ${String(code)}`}), and ends`, () => {
      const { clock, starts, end, exits } = watched();
      end(code, signal);
      expect(exits()).toBe(1);
      clock.advance(3_600_000);
      expect(starts).toHaveLength(1);
    });
  }

  it("waits the next delay for the next crash, and gives up at the crash-loop limit", () => {
    const { clock, starts, said, end, exits } = watched({
      ...CONFIG,
      crashLoop: { maxCrashes: 3, windowMs: 60_000 },
    });
    end(1);
    clock.advance(1_000);
    end(1);
    clock.advance(1_999);
    expect(starts).toHaveLength(2);
    clock.advance(1);
    expect(starts).toHaveLength(3);
    end(1);
    expect(exits()).toBe(1);
    expect(said.at(-1)).toBe(
      "reload: Reload crashed (exit code 1) too often; it is not started again",
    );
    clock.advance(3_600_000);
    expect(starts).toHaveLength(3);
  });

  it("reads an ending the way Node reports one: every crash signal, and nothing described is a stop", () => {
    for (const signal of ["SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL", "SIGFPE"]) {
      expect(shellEnding(null, signal)).toBe("crashed");
    }
    for (const signal of ["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGQUIT"]) {
      expect(shellEnding(null, signal)).toBe("stopped");
    }
    expect(shellEnding(0, null)).toBe("quit");
    expect(shellEnding(2, null)).toBe("crashed");
    expect(shellEnding(null, null)).toBe("stopped");
  });
});

describe("the hand-over to the watcher", () => {
  function handOff(env: Record<string, string | undefined>, runtimesDir: string | null = null) {
    const calls: string[] = [];
    const spawned: { command: string; args: readonly string[]; options: unknown }[] = [];
    const stdin = new PassThrough();
    let written = "";
    stdin.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const spawn = ((command: string, args: readonly string[], options: unknown) => {
      spawned.push({ command, args, options });
      return Object.assign(new EventEmitter(), {
        stdin,
        unref: () => calls.push("unref"),
      });
    }) as never;
    const handed = handOffToWatcher({
      app: {
        releaseSingleInstanceLock: () => calls.push("release"),
        exit: (code) => calls.push(`exit ${String(code)}`),
      },
      env,
      argv: ["/bin/sh", "--hidden"],
      // A binary that exists everywhere the tests run, standing in for the shell's.
      execPath: "/bin/sh",
      runtimesDir,
      script: () => "/* the watcher */",
      stability: () => DEFAULT_STABILITY,
      spawn,
    });
    const config = () => JSON.parse(written) as WatcherConfig;
    return { handed, calls, spawned, config };
  }

  it("does nothing under the watcher: the shell runs as it always did", () => {
    const { handed, calls, spawned } = handOff({ [UNDER_WATCHER_VARIABLE]: "1" });
    expect(handed).toBe(false);
    expect(calls).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it("releases the lock, starts the watcher detached on node with its script, hands it the start on stdin, and quits", async () => {
    const { handed, calls, spawned, config } = handOff({
      HOME: "/home/test",
      ANYTYPE_API_KEY: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      UNSET: undefined,
    });
    expect(handed).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["release", "unref", "exit 0"]);
    expect(spawned).toEqual([
      {
        command: "/bin/sh",
        args: ["-e", "/* the watcher */"],
        options: {
          env: {
            HOME: "/home/test",
            ANYTYPE_API_KEY: "secret",
            [UNDER_WATCHER_VARIABLE]: "1",
            ELECTRON_RUN_AS_NODE: "1",
          },
          detached: true,
          stdio: ["pipe", "inherit", "inherit"],
        },
      },
    ]);
    // The shell is started as it was, Electron and never node, with the marker; nothing of the
    // environment is on a command line.
    expect(config()).toEqual({
      command: "/bin/sh",
      args: ["--hidden"],
      env: { HOME: "/home/test", ANYTYPE_API_KEY: "secret", [UNDER_WATCHER_VARIABLE]: "1" },
      delaysMs: [1_000, 2_000, 4_000, 8_000, 16_000],
      crashLoop: { maxCrashes: 5, windowMs: 120_000 },
    });
    expect(JSON.stringify(spawned[0]?.args)).not.toContain("secret");
  });

  it("runs on the bundled node in an installed build, and unwatched when there is no node to run on", () => {
    expect(watcherNode(null, "darwin", "/x/Reload")).toEqual({
      command: "/x/Reload",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(watcherNode("/x/runtimes", "darwin", "/x/Reload").command).toMatch(
      /^\/x\/runtimes\/.*node$/,
    );
    const { handed, calls, spawned } = handOff({}, "/nowhere/runtimes");
    expect(handed).toBe(false);
    expect(calls).toEqual([]);
    expect(spawned).toEqual([]);
  });
});
