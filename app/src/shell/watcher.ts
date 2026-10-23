// The watcher (plan 0032 group 11; the old host's half of the helper pair, launcher.py
// HelperWatch): the shell's parent, which brings Reload back after a crash.
//
// A shell that starts without one hands its start over (adapters/process/watcher-handoff.ts): it
// starts the watcher, a plain node process, and quits. The watcher starts the real shell as its
// child, with the same arguments and the "under the watcher" marker, and sees its ending:
//
// * a crash (a non-zero exit, or a crash signal) is relaunched after the restart delay, under the
//   person's crash-loop limit, as the old host relaunched a crashed helper;
// * a stop from outside (SIGTERM, SIGINT, SIGKILL...) and a quit (exit 0) end the watcher too,
//   never a relaunch: the person wants Reload off.
//
// It reads nothing but its stdin (WatcherConfig, one JSON document) and holds no file, lock or
// window: the single-instance lock, the login item, the run-state file and `reload --status` all
// stay the shell's.

import { spawn } from "node:child_process";
import { crashRestartDelay } from "../domain/supervision/backoff";
import { CrashLoopBreaker } from "../domain/supervision/breaker";
import { shellEnding, type WatcherConfig } from "../domain/supervision/relaunch";

/** One started shell, as the watcher sees it. */
export interface WatchedShell {
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}

export interface WatcherDeps {
  readonly start: (config: WatcherConfig) => WatchedShell;
  readonly after: (ms: number, run: () => void) => void;
  readonly now: () => number;
  /** A line for the terminal Reload was started from: the watcher has no log of its own. */
  readonly say: (line: string) => void;
  /** The watcher ends. */
  readonly exit: () => void;
}

/** Start the shell, and start it again after each crash until the crash-loop limit. */
export function watchShell(config: WatcherConfig, deps: WatcherDeps): void {
  const breaker = new CrashLoopBreaker(config.crashLoop, deps.now);
  const launch = (): void => {
    deps.start(config).onExit((code, signal) => {
      const how = signal === null ? `exit code ${String(code)}` : signal;
      const ending = shellEnding(code, signal);
      if (ending !== "crashed") {
        // Quit, or stopped from outside: the person wants Reload off, and so the watcher goes.
        deps.exit();
        return;
      }
      if (!breaker.recordCrash()) {
        deps.say(`reload: Reload crashed (${how}) too often; it is not started again`);
        deps.exit();
        return;
      }
      const delay = crashRestartDelay(breaker.crashesInWindow(), { delaysMs: config.delaysMs });
      deps.say(`reload: Reload crashed (${how}); starting it again in ${String(delay)} ms`);
      deps.after(delay, launch);
    });
  };
  launch();
}

/** The watcher process: its config from stdin, the shell started with the terminal inherited. */
export function runWatcher(): void {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const config = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WatcherConfig;
    watchShell(config, {
      start: ({ command, args, env }) => {
        const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
        return {
          onExit: (listener) => {
            child.once("exit", listener);
            // Not started at all (no such binary): nothing to bring back, so taken as a stop.
            child.once("error", () => {
              listener(null, null);
            });
          },
        };
      },
      after: (ms, run) => {
        setTimeout(run, ms);
      },
      now: () => performance.now(),
      say: (line) => {
        process.stderr.write(`${line}\n`);
      },
      exit: () => {
        process.exit(0);
      },
    });
  });
}
