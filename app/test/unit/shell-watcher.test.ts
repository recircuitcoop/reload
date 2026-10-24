// The watcher (plan 0032 group 11; the old host's HelperWatch, test_helper_launcher.py): the
// shell's parent, which relaunches a crashed shell and nothing else.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { handOffToWatcher, watcherNode } from "../../src/adapters/process/watcher-handoff";
import {
  shellEnding,
  STARTED_FD,
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
  crashLoop: { maxCrashes: 5, windowMs: 600_000 },
  restartAttempts: 5,
  quitFile: "/user-data/quit-recorded.json",
};

/** A watcher over fake shells: each start recorded, each ended by the test. */
function watched(config: WatcherConfig = CONFIG) {
  const clock = new FakeClock();
  const starts: WatcherConfig[] = [];
  const shells: ((code: number | null, signal: string | null) => void)[] = [];
  const said: string[] = [];
  /** The quit record as the watcher sees the file: absent, or there. */
  const quit = { recorded: false, cleared: 0 };
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
    quitRecorded: () => quit.recorded,
    clearQuit: () => {
      quit.recorded = false;
      quit.cleared += 1;
    },
    say: (line) => said.push(line),
    exit: () => {
      exits += 1;
    },
  });
  const end = (code: number | null, signal: string | null = null) => {
    shells.at(-1)?.(code, signal);
  };
  return { clock, starts, said, end, quit, exits: () => exits };
}

const named = (code: number | null, signal: string | null) => signal ?? `exit code ${String(code)}`;

describe("the watcher", () => {
  it("starts the shell once, as it was started, with the marker set", () => {
    const { starts } = watched();
    expect(starts).toEqual([CONFIG]);
  });

  // test_the_host_relaunches_a_crashed_helper[ending0..4]: a non-zero exit and a crash signal;
  // and SIGTRAP, how a V8 heap out of memory ends Electron's main process on macOS.
  for (const [code, signal] of [
    [1, null],
    [134, null],
    [null, "SIGSEGV"],
    [null, "SIGABRT"],
    [null, "SIGBUS"],
    [null, "SIGTRAP"],
  ] as const) {
    it(`relaunches a shell that crashed (${named(code, signal)}) when its delay has run out`, () => {
      const { clock, starts, said, end, exits } = watched();
      end(code, signal);
      // Scheduled, not slept through: the relaunch happens when the first delay runs out.
      clock.advance(999);
      expect(starts).toHaveLength(1);
      // test_a_scheduled_relaunch_is_visible_before_it_happens: said before it happens.
      expect(said).toEqual([
        `reload: Reload crashed (${named(code, signal)}); starting it again in 1000 ms`,
      ]);
      clock.advance(1);
      expect(starts).toHaveLength(2);
      expect(starts[1]).toEqual(CONFIG);
      expect(exits()).toBe(0);
    });
  }

  // test_the_host_never_relaunches_a_helper_it_did_not_see_crash[ending0..4]: a kill and a quit.
  for (const [code, signal] of [
    [null, "SIGTERM"],
    [null, "SIGINT"],
    [null, "SIGKILL"],
    [0, null],
    [null, null],
  ] as const) {
    it(`never relaunches a shell that was stopped or quit (${named(code, signal)}), and ends`, () => {
      const { clock, starts, end, exits } = watched();
      end(code, signal);
      expect(exits()).toBe(1);
      clock.advance(3_600_000);
      expect(starts).toHaveLength(1);
    });
  }

  it("never relaunches a shell that ended non-zero or by a crash signal while its quit was recorded", () => {
    // test_a_crash_during_a_recorded_quit_is_still_a_quit, and
    // test_an_unreadable_quit_record_still_counts_as_a_quit: the file there at all is the quit.
    for (const [code, signal] of [
      [1, null],
      [null, "SIGSEGV"],
    ] as const) {
      const { clock, starts, end, quit, exits } = watched();
      quit.recorded = true;
      end(code, signal);
      expect(exits()).toBe(1);
      clock.advance(3_600_000);
      expect(starts).toHaveLength(1);
      expect(quit.recorded).toBe(false);
    }
  });

  it("clears the quit the last run recorded before every start", () => {
    // test_a_start_clears_the_quit_left_by_the_last_run.
    const { clock, quit, end, starts } = watched();
    expect(quit.cleared).toBe(1);
    end(1);
    clock.advance(1_000);
    expect(starts).toHaveLength(2);
    expect(quit.cleared).toBe(2);
  });

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

  it("gives up after its restart attempts, however far apart the crashes are", () => {
    // test_a_helper_that_cannot_be_brought_back_takes_the_application_off: max_attempts 2.
    const { clock, starts, end, exits } = watched({ ...CONFIG, restartAttempts: 2 });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      end(1);
      clock.advance(3_600_000);
      expect(starts).toHaveLength(attempt + 1);
    }
    end(1);
    expect(exits()).toBe(1);
    clock.advance(3_600_000);
    expect(starts).toHaveLength(3);
  });

  it("reads an ending the way Node reports one: every crash signal, and nothing described is a stop", () => {
    for (const signal of [
      "SIGSEGV",
      "SIGABRT",
      "SIGBUS",
      "SIGILL",
      "SIGFPE",
      "SIGTRAP",
      "SIGSYS",
    ]) {
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
    const logged: string[] = [];
    const spawned: { command: string; args: readonly string[]; options: unknown }[] = [];
    const stdin = new PassThrough();
    const started = new PassThrough();
    let written = "";
    stdin.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const watcher = Object.assign(new EventEmitter(), {
      stdin,
      stdio: [stdin, null, null, started],
      unref: () => calls.push("unref"),
    });
    const spawn = ((command: string, args: readonly string[], options: unknown) => {
      spawned.push({ command, args, options });
      return watcher;
    }) as never;
    const handed = handOffToWatcher({
      app: {
        releaseSingleInstanceLock: () => calls.push("release"),
        exit: (code) => calls.push(`exit ${String(code)}`),
        getPath: () => "/user-data",
      },
      env,
      argv: ["/bin/sh", "--hidden"],
      // A binary that exists everywhere the tests run, standing in for the shell's.
      execPath: "/bin/sh",
      runtimesDir,
      script: () => "/* the watcher */",
      stability: () => DEFAULT_STABILITY,
      log: (line) => logged.push(line),
      spawn,
    })(() => calls.push("runs itself"));
    const config = () => JSON.parse(written) as WatcherConfig;
    return { handed, calls, logged, spawned, config, watcher, started };
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("does nothing under the watcher: the shell runs as it always did", () => {
    const { handed, calls, spawned } = handOff({ [UNDER_WATCHER_VARIABLE]: "1" });
    expect(handed).toBe(false);
    expect(calls).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it("releases the lock, starts the watcher detached on node, and quits once the watcher says the shell runs", async () => {
    const { handed, calls, spawned, config, started } = handOff({
      HOME: "/home/test",
      ANYTYPE_API_KEY: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      UNSET: undefined,
    });
    expect(handed).toBe(true);
    await settle();
    // Not before the watcher has started the real shell: until then this one could still run.
    expect(calls).toEqual(["release", "unref"]);
    started.write("started\n");
    await settle();
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
          stdio: ["pipe", "inherit", "inherit", "pipe"],
        },
      },
    ]);
    expect(STARTED_FD).toBe(3);
    // The shell is started as it was, Electron and never node, with the marker; nothing of the
    // environment is on a command line.
    expect(config()).toEqual({
      command: "/bin/sh",
      args: ["--hidden"],
      env: { HOME: "/home/test", ANYTYPE_API_KEY: "secret", [UNDER_WATCHER_VARIABLE]: "1" },
      delaysMs: [1_000, 2_000, 4_000, 8_000, 16_000],
      crashLoop: { maxCrashes: 5, windowMs: 600_000 },
      restartAttempts: 5,
      quitFile: "/user-data/quit-recorded.json",
    });
    expect(JSON.stringify(spawned[0]?.args)).not.toContain("secret");
  });

  it("runs this shell itself, and says so, when the watcher cannot start or ends before the shell runs", async () => {
    const failed = handOff({});
    failed.watcher.emit("error", new Error("spawn EACCES"));
    // A later exit of that watcher changes nothing: the shell runs once, and never quits.
    failed.watcher.emit("exit", null, null);
    await settle();
    expect(failed.calls).toEqual(["release", "unref", "runs itself"]);
    expect(failed.logged).toEqual([
      "the watcher could not start: spawn EACCES; Reload runs without the watcher",
    ]);
    const ended = handOff({});
    ended.watcher.emit("exit", 1, null);
    ended.started.write("started\n");
    await settle();
    expect(ended.calls).toEqual(["release", "unref", "runs itself"]);
    expect(ended.logged).toEqual([
      "the watcher ended (exit code 1) before Reload ran; Reload runs without the watcher",
    ]);
    const unwritable = handOff({});
    unwritable.watcher.stdin.emit("error", new Error("write EPIPE"));
    await settle();
    expect(unwritable.calls).toEqual(["release", "unref", "runs itself"]);
  });

  it("runs on the bundled node in an installed build, and unwatched when there is no node to run on", () => {
    expect(watcherNode(null, "darwin", "/x/Reload")).toEqual({
      command: "/x/Reload",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(watcherNode("/x/runtimes", "darwin", "/x/Reload").command).toMatch(
      /^\/x\/runtimes\/.*node$/,
    );
    const { handed, calls, spawned, logged } = handOff({}, "/nowhere/runtimes");
    expect(handed).toBe(false);
    expect(calls).toEqual([]);
    expect(spawned).toEqual([]);
    expect(logged).toEqual([expect.stringContaining("Reload runs without it")]);
  });
});
